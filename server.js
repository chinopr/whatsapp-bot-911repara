const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
require('dotenv').config();

// ─── Validación fail-fast de variables de entorno ─────────────────────────────
const REQUIRED_ENV = ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'CLAUDE_API_KEY', 'GOOGLE_API_KEY', 'SHEET_ID'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`ERROR FATAL: Variables de entorno faltantes: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Redis opcional ───────────────────────────────────────────────────────────
let redisClient = null;
(async () => {
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      redisClient = createClient({ url: process.env.REDIS_URL });
      redisClient.on('error', (err) => console.error('Redis error:', err.message));
      await redisClient.connect();
      console.log('Redis conectado');
    } catch (err) {
      console.warn('Redis no disponible, usando memoria:', err.message);
      redisClient = null;
    }
  }
})();

const app = express();
app.use(express.json());

// ─── Configuración ────────────────────────────────────────────────────────────
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const CLAUDE_API_KEY  = process.env.CLAUDE_API_KEY;
const GOOGLE_API_KEY  = process.env.GOOGLE_API_KEY;
const SHEET_ID        = process.env.SHEET_ID;
const OWNER_PHONE     = process.env.OWNER_PHONE; // ej: 17879966976 (sin + ni espacios)
const CLAUDE_MODEL    = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || null;
const WA_APP_SECRET   = process.env.WHATSAPP_APP_SECRET || null;

const BOT_VERSION           = '4.6';
const WHATSAPP_API_VERSION  = 'v21.0';
const HISTORY_TTL_SECONDS   = 60 * 60 * 24; // 24 horas
const MAX_HISTORY_MESSAGES  = 10;
const RATE_LIMIT_WINDOW_MS  = 60 * 1000;
const RATE_LIMIT_MAX_MSGS   = 10;
const CLAUDE_TIMEOUT_MS     = 15000; // 15 seg
const SHEETS_TIMEOUT_MS     = 10000; // 10 seg (Google Sheets)
const WA_TIMEOUT_MS         = 10000; // 10 seg (WhatsApp API)

const MAPS_URL = 'https://www.google.com/maps/dir//911+repara.me,+Walgreens,+Carretera+2+Int+Carretera+149+Frente+Farmacia,+Manat%C3%AD,+00674/@18.436519,-66.4390542,15z/data=!4m8!4m7!1m0!1m5!1m1!1s0x8c031780deae45f3:0x13d55e015794b54e!2m2!1d-66.475142!2d18.431694?entry=ttu&g_ep=EgoyMDI2MDMwOS4wIKXMDSoASAFQAw%3D%3D';

// ─── Stats (en memoria, se reinician con el servidor) ─────────────────────────
const stats = {
  messagesReceived: 0,
  leadsCapturados: 0,
  escalaciones: 0,
  erroresClaude: 0,
  startTime: new Date().toISOString(),
};

const client = new Anthropic({ apiKey: CLAUDE_API_KEY });

// ─── Deduplicación de mensajes (Redis con fallback a memoria) ─────────────────
const processedMsgIds = new Set();
setInterval(() => processedMsgIds.clear(), 10 * 60 * 1000); // limpiar cada 10 min

async function isDuplicate(msgId) {
  if (redisClient) {
    const exists = await redisClient.exists(`dedup:${msgId}`);
    if (exists) return true;
    await redisClient.setEx(`dedup:${msgId}`, 600, '1'); // 10 min TTL
    return false;
  }
  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.add(msgId);
  return false;
}

// ─── Historial (Redis o memoria) ──────────────────────────────────────────────
const memoryHistory = {};
const memoryNewUsers = new Set();

async function getHistory(userId) {
  if (redisClient) {
    const data = await redisClient.get(`hist:${userId}`);
    return data ? JSON.parse(data) : [];
  }
  return memoryHistory[userId] || [];
}

async function saveHistory(userId, history) {
  if (redisClient) {
    await redisClient.setEx(`hist:${userId}`, HISTORY_TTL_SECONDS, JSON.stringify(history));
  } else {
    memoryHistory[userId] = history;
  }
}

async function isNewUser(userId) {
  if (redisClient) {
    const exists = await redisClient.exists(`seen:${userId}`);
    return exists === 0;
  }
  return !memoryNewUsers.has(userId);
}

async function markUserSeen(userId) {
  if (redisClient) {
    await redisClient.setEx(`seen:${userId}`, 60 * 60 * 24 * 90, '1'); // 90 días
  } else {
    memoryNewUsers.add(userId);
  }
}

// ─── Rate limiting (Redis con fallback a memoria) ─────────────────────────────
const rateLimitMap = {};

async function isRateLimited(userId) {
  if (redisClient) {
    const key = `rl:${userId}`;
    const count = await redisClient.incr(key);
    if (count === 1) await redisClient.expire(key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
    return count > RATE_LIMIT_MAX_MSGS;
  }
  const now = Date.now();
  if (!rateLimitMap[userId]) {
    rateLimitMap[userId] = { count: 1, windowStart: now };
    return false;
  }
  const state = rateLimitMap[userId];
  if (now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state.count = 1;
    state.windowStart = now;
    return false;
  }
  state.count++;
  return state.count > RATE_LIMIT_MAX_MSGS;
}

// ─── Horario de negocio ───────────────────────────────────────────────────────
function isBusinessHours() {
  const prTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' }));
  const day  = prTime.getDay(); // 0=Dom, 1=Lun, 2=Mar ... 5=Vie, 6=Sáb
  const mins = prTime.getHours() * 60 + prTime.getMinutes();
  // Martes(2) a Viernes(5): 11:30am–5:30pm
  return day >= 2 && day <= 5 && mins >= 11 * 60 + 30 && mins <= 17 * 60 + 30;
}

// ─── WhatsApp — helpers ───────────────────────────────────────────────────────
const WA_HEADERS = () => ({
  Authorization: `Bearer ${WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json',
});
const WA_URL = (id) => `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${id}/messages`;

async function sendWhatsAppMessage(phoneNumberId, to, text) {
  await axios.post(WA_URL(phoneNumberId),
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: WA_HEADERS(), timeout: WA_TIMEOUT_MS }
  );
}

async function markAsRead(phoneNumberId, messageId) {
  try {
    await axios.post(WA_URL(phoneNumberId),
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: WA_HEADERS(), timeout: 5000 }
    );
  } catch (_) { /* no crítico */ }
}

async function sendLocationButton(phoneNumberId, to) {
  await axios.post(WA_URL(phoneNumberId), {
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: '📍 *Carretera 149, intersección con Carretera 2*\nFrente a Manatí Plaza Shopping Center\n\nToca el botón para abrir Google Maps:' },
      action: { name: 'cta_url', parameters: { display_text: 'Como llegar 📍', url: MAPS_URL } },
    },
  }, { headers: WA_HEADERS(), timeout: WA_TIMEOUT_MS });
}

async function sendWelcomeMenu(phoneNumberId, to) {
  try {
    await axios.post(WA_URL(phoneNumberId), {
      messaging_product: 'whatsapp', to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '¡Hola! Soy Alex 👋' },
        body:   { text: '¿En qué te puedo ayudar hoy? Selecciona una opción o escríbeme directamente.' },
        footer: { text: '911reparame • Manatí, PR' },
        action: {
          button: 'Ver opciones',
          sections: [{
            title: 'Servicios',
            rows: [
              { id: 'menu_cotizar',   title: '💰 Cotizar reparación',      description: 'Obtén un precio estimado' },
              { id: 'menu_horario',   title: '🕐 Horario y ubicación',     description: 'Dónde estamos y cuándo' },
              { id: 'menu_ventas',    title: '📱 Equipos en venta',        description: 'Ver equipos disponibles' },
              { id: 'menu_asesor',    title: '👨‍💻 Hablar con un asesor',   description: 'Te contactamos pronto' },
            ],
          }],
        },
      },
    }, { headers: WA_HEADERS(), timeout: WA_TIMEOUT_MS });
  } catch (err) {
    // Si falla el menú (ej. sandbox no lo soporta), enviar texto simple
    await sendWhatsAppMessage(phoneNumberId, to,
      '¡Hola! Soy *Alex*, asistente virtual de *911reparame* 👋\n\nPuedo ayudarte con cotizaciones, horario, ubicación y equipos en venta. ¿En qué te puedo ayudar?');
  }
}

// ─── Notificar al dueño cuando llega un lead ──────────────────────────────────
async function notifyOwner(nombre, telefono, servicio, clienteWa, history = []) {
  if (!OWNER_PHONE || !PHONE_NUMBER_ID) return;
  try {
    // Resumen de conversación (últimos 4 intercambios)
    const snippet = history.slice(-4)
      .map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content.substring(0, 80)}${m.content.length > 80 ? '…' : ''}`)
      .join('\n');

    const msg = `🔔 *Nuevo Lead — 911reparame*\n\n👤 *Nombre:* ${nombre}\n📞 *Teléfono:* ${telefono}\n🔧 *Servicio:* ${servicio}\n📱 *WhatsApp:* wa.me/${clienteWa}${snippet ? `\n\n💬 *Contexto:*\n${snippet}` : ''}`;
    await sendWhatsAppMessage(PHONE_NUMBER_ID, OWNER_PHONE, msg);
    stats.escalaciones++;
    console.log('Dueño notificado del lead:', nombre);
  } catch (err) {
    console.error('Error notificando al dueño:', err.message);
  }
}

// ─── Google Sheets — lead ─────────────────────────────────────────────────────
async function saveLead(nombre, telefono, servicio, whatsappNum) {
  try {
    const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const fecha = new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Leads!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[fecha, nombre, telefono, servicio, whatsappNum, 'Nuevo']] },
    });
    console.log('Lead guardado:', nombre, telefono, servicio);
  } catch (err) {
    console.error('Error guardando lead:', err.message);
  }
}

// ─── Google Sheets — precios ──────────────────────────────────────────────────
let sheetCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchSheetData(sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}?key=${GOOGLE_API_KEY}`;
  const res = await axios.get(url, { timeout: SHEETS_TIMEOUT_MS });
  const rows = res.data.values || [];
  // Fila 0 = título, Fila 1 = descripción, Fila 2 = encabezados reales, Fila 3+ = datos
  if (rows.length < 4) return [];
  const headers = rows[2];
  return rows.slice(3).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

async function getPriceData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && sheetCache && (now - cacheTimestamp) < CACHE_TTL_MS) return sheetCache;
  console.log('Actualizando cache de precios...');
  try {
    const [reparaciones, ventas, accesorios] = await Promise.all([
      fetchSheetData('Reparaciones'),
      fetchSheetData('Ventas'),
      fetchSheetData('Accesorios'),
    ]);
    sheetCache = { reparaciones, ventas, accesorios };
    cacheTimestamp = now;
    console.log('Cache actualizado:', reparaciones.length, 'reparaciones,', ventas.length, 'ventas,', accesorios.length, 'accesorios');
    return sheetCache;
  } catch (err) {
    console.error('Error leyendo Sheets:', err.message);
    return sheetCache || { reparaciones: [], ventas: [], accesorios: [] };
  }
}

// ─── Búsqueda inteligente de reparaciones ─────────────────────────────────────
const BRAND_ALIASES = {
  apple:       ['apple', 'iphone', 'ipad', 'macbook', 'mac'],
  samsung:     ['samsung', 'galaxy', 's24', 's23', 's22', 's21', 's20', 's10', 'note', 'a54', 'a34', 'a15'],
  google:      ['google', 'pixel'],
  motorola:    ['motorola', 'moto'],
  lg:          ['lg'],
  sony:        ['sony', 'xperia'],
  huawei:      ['huawei'],
  oneplus:     ['oneplus', 'one plus'],
  nintendo:    ['nintendo', 'switch'],
  playstation: ['playstation', 'ps4', 'ps5', 'ps3'],
  xbox:        ['xbox'],
};

// Recibe el historial completo para no perder contexto entre mensajes
function filterRepairsByConversation(reparaciones, history, currentMsg) {
  // Concatenar todos los mensajes del cliente para tener contexto completo
  const allText = [
    ...history.filter(m => m.role === 'user').map(m => m.content),
    currentMsg,
  ].join(' ').toLowerCase();

  let brandAliases = null;
  for (const [, aliases] of Object.entries(BRAND_ALIASES)) {
    if (aliases.some(a => allText.includes(a))) { brandAliases = aliases; break; }
  }

  let filtered = reparaciones;
  if (brandAliases) {
    filtered = reparaciones.filter(r =>
      brandAliases.some(a => r['Marca'].toLowerCase().includes(a) || r['Modelo'].toLowerCase().includes(a))
    );
    const modelWords = allText.match(/\b(iphone\s*\d+[\w\s]*|s\d+\s*\w*|pixel\s*\d+\w*|galaxy\s*\w+|ipad\s*\w*|note\s*\d+|a\d+|ps\d|xbox\s*\w*|switch)\b/gi) || [];
    if (modelWords.length > 0) {
      const modelFiltered = filtered.filter(r =>
        modelWords.some(w => r['Modelo'].toLowerCase().includes(w.toLowerCase().trim()))
      );
      if (modelFiltered.length > 0) filtered = modelFiltered;
    }
  }

  if (filtered.length === 0 || filtered === reparaciones) {
    const seen = new Set();
    filtered = reparaciones.filter(r => {
      const key = `${r['Marca']} ${r['Modelo']}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 60);
  }

  return filtered;
}

function buildPriceContext(data, history = [], currentMsg = '') {
  let ctx = '';
  const repsActivas = data.reparaciones.filter(r => r['Notas / Estado'] !== 'Descontinuado');

  if (repsActivas.length > 0) {
    const relevant = (history.length > 0 || currentMsg)
      ? filterRepairsByConversation(repsActivas, history, currentMsg)
      : repsActivas.slice(0, 80);
    ctx += '\nREPARACIONES:\n';
    relevant.forEach(r => {
      const min = (r['Precio Mín ($)'] || '').replace(/^\$/, '');
      const max = (r['Precio Máx ($)'] || '').replace(/^\$/, '');
      if (!min && !max) return;
      ctx += `- ${r['Dispositivo'] || ''} ${r['Marca'] || ''} ${r['Modelo'] || ''} - ${r['Servicio'] || ''}: $${min}-$${max} | ${r['Tiempo Estim.'] || 'N/A'}\n`;
    });
  }

  const ventasDisp = data.ventas.filter(v => v['Disponibilidad'] === 'Sí');
  if (ventasDisp.length > 0) {
    ctx += '\nEQUIPOS EN VENTA:\n';
    ventasDisp.forEach(v => {
      const precio = (v['Precio ($)'] || '').replace(/^\$/, '');
      if (!precio) return;
      ctx += `- ${v['Tipo'] || ''} ${v['Marca'] || ''} ${v['Modelo'] || ''} - ${v['Condición'] || ''} - $${precio}\n`;
    });
  }

  const accDisp = data.accesorios.filter(a => a['Disponibilidad'] === 'Sí');
  if (accDisp.length > 0) {
    ctx += '\nACCESORIOS:\n';
    accDisp.forEach(a => {
      const precio = (a['Precio ($)'] || '').replace(/^\$/, '');
      if (!precio) return;
      ctx += `- ${a['Tipo'] || ''}: ${a['Descripción'] || ''} - $${precio}\n`;
    });
  }

  return ctx;
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(priceContext, lang = 'es') {
  const now = new Date().toLocaleString('es-PR', {
    timeZone: 'America/Puerto_Rico',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const abierto = isBusinessHours();
  const langInstruction = lang === 'en'
    ? 'The customer is writing in ENGLISH — respond entirely in English.'
    : 'Responde SIEMPRE en español.';

  return `Eres Alex, asistente virtual de 911reparame en Puerto Rico. ${langInstruction} Sé amigable y conciso (max 3-4 oraciones). Usa emojis ocasionalmente.

FECHA Y HORA ACTUAL (Puerto Rico): ${now}
ESTADO DEL NEGOCIO AHORA: ${abierto ? '🟢 ABIERTO' : '🔴 CERRADO'}
${!abierto ? '⚠️ Si el cliente pregunta si están abiertos, indica que en este momento están cerrados y menciona el horario regular.' : ''}

INFORMACIÓN DEL NEGOCIO:
- Nombre: 911reparame
- Teléfono: 787-996-6976
- Ubicación: Carretera 149, intersección con la Carretera 2, frente a Manatí Plaza Shopping Center
- Horario: Martes a Viernes de 11:30am a 5:30pm | Algunos sábados (horario variable)
- Facebook: 911reparame
- Instagram: 911reparame
- Web: 911reparame.com

SERVICIOS: Reparación de celulares, tabletas y consolas. Venta de equipos. Servicios prepagados. Accesorios.

GARANTÍAS:
- Reparaciones: 15 a 30 días dependiendo del servicio
- Equipos nuevos: 1 año con el fabricante

MÉTODOS DE PAGO: Efectivo (cash), ATH Móvil, ATH, Visa, PayPal, Bitcoin

DIAGNÓSTICO:
- Se cobra $10 por diagnóstico
- Si el cliente acepta la reparación, esos $10 se descuentan del precio final

INSTRUCCIONES DE COTIZACIÓN:
- Cuando el cliente mencione un dispositivo o servicio, comparte enseguida el rango de precio de forma natural
- Para afinar la cotización pide: marca, modelo exacto y descripción del problema
- Nunca inventes precios que no estén en la lista
- Si hay varios modelos similares, muestra los rangos disponibles
- Si el servicio no está en la lista di que un asesor confirmará el precio

CAPTURA DE LEADS:
- Cuando el cliente quiera proceder, pide su nombre y teléfono
- Al recibir nombre y teléfono, incluye al FINAL de tu respuesta:
  [LEAD: nombre=NOMBRE_AQUI, telefono=TELEFONO_AQUI, servicio=SERVICIO_AQUI]
- Esta etiqueta es solo para el sistema

UBICACIÓN Y DIRECCIONES:
- Cuando pregunten cómo llegar o dónde están, incluye al FINAL: [UBICACION]
- No incluyas URLs largas en tu texto

OTRAS INSTRUCCIONES:
- Si no sabes algo di que un asesor confirmará pronto
- Si preguntan por horario de sábado indica que es variable y que llamen al 787-996-6976

PRECIOS ACTUALIZADOS:
${priceContext}`;
}

// ─── Detección de idioma ──────────────────────────────────────────────────────
function detectLanguage(text) {
  const enWords = /\b(hi|hello|hey|how|much|repair|cost|price|where|when|open|closed|phone|screen|battery|fix|buy|sell|help|please|thanks|thank|you|is|are|do|can|what|your|hours|location)\b/i;
  const esWords = /\b(hola|precio|cuánto|reparar|pantalla|batería|celular|dónde|cuándo|abierto|cerrado|ayuda|gracias|cómo|tiene|están|cuál|horario|ubicación|quisiera|necesito)\b/i;
  const enScore = (text.match(enWords) || []).length;
  const esScore = (text.match(esWords) || []).length;
  return enScore > esScore ? 'en' : 'es';
}

// ─── Manejar selección de menú ────────────────────────────────────────────────
function menuToText(menuId, lang = 'es') {
  const map = {
    es: {
      menu_cotizar: '¿Cuánto cuesta reparar mi celular?',
      menu_horario: '¿Cuál es su horario y dónde están ubicados?',
      menu_ventas:  '¿Qué equipos tienen en venta?',
      menu_asesor:  'Quisiera hablar con un asesor.',
    },
    en: {
      menu_cotizar: 'How much does it cost to repair my phone?',
      menu_horario: 'What are your hours and where are you located?',
      menu_ventas:  'What devices do you have for sale?',
      menu_asesor:  'I would like to speak with an advisor.',
    },
  };
  return (map[lang] || map.es)[menuId] || null;
}

// ─── Middleware: validación de firma WhatsApp ─────────────────────────────────
function verifyWebhookSignature(req, res, next) {
  if (!WA_APP_SECRET) return next(); // sin secreto configurado, skip
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) { res.sendStatus(401); return; }
  const expectedSig = 'sha256=' + crypto.createHmac('sha256', WA_APP_SECRET).update(JSON.stringify(req.body)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    res.sendStatus(401);
    return;
  }
  next();
}

// ─── Middleware: proteger endpoints admin ─────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) { res.status(403).json({ error: 'Endpoint deshabilitado. Configure ADMIN_TOKEN.' }); return; }
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) { res.sendStatus(403); return; }
  next();
}

// ─── Webhook verificación ─────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const verify_token = req.query['hub.verify_token'];
  const challenge    = req.query['hub.challenge'];
  if (verify_token === VERIFY_TOKEN) { console.log('Webhook verificado'); res.send(challenge); }
  else res.sendStatus(403);
});

// ─── Webhook mensajes ─────────────────────────────────────────────────────────
app.post('/webhook', verifyWebhookSignature, async (req, res) => {
  res.sendStatus(200);
  try {
    const entry          = req.body?.entry?.[0];
    const changes        = entry?.changes?.[0];
    const message        = changes?.value?.messages?.[0];
    if (!message) return;

    const msgId           = message.id;
    const from            = message.from;
    const phone_number_id = changes?.value?.metadata?.phone_number_id;

    // ── Deduplicación ─────────────────────────────────────────────────────
    if (await isDuplicate(msgId)) { console.log('Mensaje duplicado ignorado:', msgId); return; }

    // ── Mark as read ──────────────────────────────────────────────────────
    await markAsRead(phone_number_id, msgId);

    // ── Rate limiting ─────────────────────────────────────────────────────
    if (await isRateLimited(from)) {
      await sendWhatsAppMessage(phone_number_id, from, 'Estás enviando mensajes muy rápido. Por favor espera un momento. 🙏');
      return;
    }

    // ── Extraer texto (mensaje normal, selección de menú o imagen) ─────────
    let msg_body = null;
    let isImageMsg = false;

    if (message.type === 'text') {
      msg_body = message.text.body.trim().substring(0, 800); // límite 800 chars
    } else if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
      const menuId = message.interactive.list_reply.id;
      const history0 = await getHistory(from);
      const lang0 = history0.length > 0
        ? detectLanguage(history0.filter(m => m.role === 'user').map(m => m.content).join(' '))
        : 'es';
      msg_body = menuToText(menuId, lang0);
      if (!msg_body) return;
    } else if (['image', 'document', 'video'].includes(message.type)) {
      isImageMsg = true;
      msg_body = `[El cliente envió una ${message.type === 'image' ? 'foto de su dispositivo' : 'archivo'}]`;
    } else if (message.type === 'audio') {
      await sendWhatsAppMessage(phone_number_id, from,
        'Por el momento no puedo procesar notas de voz 🎙️. Escríbeme tu consulta y con gusto te ayudo. 😊');
      return;
    } else {
      await sendWhatsAppMessage(phone_number_id, from,
        'Por el momento solo proceso mensajes de texto 📝. Descríbeme tu consulta. 😊');
      return;
    }

    stats.messagesReceived++;
    console.log('Mensaje de', from, ':', msg_body);

    // ── Comando reiniciar ─────────────────────────────────────────────────
    if (/^(reiniciar|reset|restart|borrar|limpiar)$/i.test(msg_body)) {
      await saveHistory(from, []);
      await sendWhatsAppMessage(phone_number_id, from,
        '✅ Conversación reiniciada. ¿En qué te puedo ayudar? 😊');
      return;
    }

    // ── Bienvenida para usuario nuevo ─────────────────────────────────────
    const newUser = await isNewUser(from);
    if (newUser) {
      await markUserSeen(from);
      await sendWelcomeMenu(phone_number_id, from);
      // Si solo saludó (hola, hi, etc.) terminar aquí para no duplicar respuesta
      if (/^(hola|hi|hello|buenas|hey|buen|saludos|ola)[\s!]*$/i.test(msg_body)) return;
    }

    // ── Historial ─────────────────────────────────────────────────────────
    let history = await getHistory(from);
    history.push({ role: 'user', content: msg_body });
    if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(-MAX_HISTORY_MESSAGES);

    // ── Detectar idioma desde toda la conversación del usuario ────────────
    const allUserText = history.filter(m => m.role === 'user').map(m => m.content).join(' ');
    const lang = detectLanguage(allUserText);

    // ── Si es imagen, responder guiando al cliente ────────────────────────
    if (isImageMsg) {
      const imgReply = lang === 'en'
        ? '📸 Thanks for sending the photo! To give you an accurate quote, please tell me:\n1. Device brand and model\n2. What type of repair you need\n\nOr call us at *787-996-6976* and we can review it in person. 😊'
        : '📸 ¡Gracias por enviar la foto! Para darte un presupuesto preciso, cuéntame:\n1. Marca y modelo del equipo\n2. Qué tipo de reparación necesitas\n\nTambién puedes llamarnos al *787-996-6976* para revisarlo en persona. 😊';
      history.push({ role: 'assistant', content: imgReply });
      await saveHistory(from, history);
      await sendWhatsAppMessage(phone_number_id, from, imgReply);
      return;
    }

    // ── Precios con contexto de conversación completa ─────────────────────
    const priceData    = await getPriceData();
    const priceContext = buildPriceContext(priceData, history, msg_body);
    const systemPrompt = buildSystemPrompt(priceContext, lang);

    // ── Llamada a Claude con timeout ──────────────────────────────────────
    let reply;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
      const aiResponse = await client.messages.create(
        { model: CLAUDE_MODEL, max_tokens: 500, system: systemPrompt, messages: history },
        { signal: controller.signal }
      );
      clearTimeout(timer);
      reply = aiResponse.content[0].text;
    } catch (claudeErr) {
      console.error('Error Claude:', claudeErr.message);
      stats.erroresClaude++;
      reply = lang === 'en'
        ? 'I\'m having a technical issue right now. Please call us at 787-996-6976 or try again in a moment. 🙏'
        : 'En este momento tengo un problema técnico. Por favor llámanos al 787-996-6976 o escríbenos en un momento. 🙏';
      history.push({ role: 'assistant', content: reply });
      await saveHistory(from, history);
      await sendWhatsAppMessage(phone_number_id, from, reply);
      return;
    }

    // ── Detectar lead ─────────────────────────────────────────────────────
    const leadMatch = reply.match(/\[LEAD:\s*nombre=([^,\]]+),\s*telefono=([^,\]]+),\s*servicio=([^\]]+)\]/i);
    if (leadMatch) {
      const [, nombre, telefono, servicio] = leadMatch;
      reply = reply.replace(leadMatch[0], '').trim();
      await saveLead(nombre.trim(), telefono.trim(), servicio.trim(), from);
      await notifyOwner(nombre.trim(), telefono.trim(), servicio.trim(), from, history);
      stats.leadsCapturados++;
    }

    // ── Detectar botón ubicación ──────────────────────────────────────────
    const sendLocation = /\[UBICACION\]/i.test(reply);
    reply = reply.replace(/\[UBICACION\]/gi, '').trim();

    // ── Guardar historial y enviar ────────────────────────────────────────
    history.push({ role: 'assistant', content: reply });
    await saveHistory(from, history);
    await sendWhatsAppMessage(phone_number_id, from, reply);
    if (sendLocation) await sendLocationButton(phone_number_id, from);
    console.log('Respuesta enviada a', from, sendLocation ? '+ botón ubicación' : '');

  } catch (err) {
    console.error('Error webhook:', err.message, JSON.stringify(err?.response?.data));
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok', negocio: '911reparame Bot', version: BOT_VERSION,
    whatsapp_api: WHATSAPP_API_VERSION,
    redis: redisClient ? 'conectado' : 'memoria',
    abierto: isBusinessHours(),
  });
});

// ─── Debug precios ─────────────────────────────────────────────────────────────
app.get('/debug-prices', requireAdmin, async (req, res) => {
  const query = req.query.q || '';
  const data  = await getPriceData();
  const context = buildPriceContext(data, [], query);
  res.json({
    totales: { reparaciones: data.reparaciones.length, ventas: data.ventas.length, accesorios: data.accesorios.length },
    query_usada: query || '(ninguna)',
    contexto_enviado_al_bot: context,
    muestra_reparaciones: data.reparaciones.slice(0, 5),
  });
});

// ─── Forzar recarga de caché de precios ───────────────────────────────────────
app.get('/refresh-prices', requireAdmin, async (req, res) => {
  await getPriceData(true);
  res.json({ status: 'ok', mensaje: 'Cache de precios actualizado', timestamp: new Date().toISOString() });
});

// ─── Stats / métricas del bot ─────────────────────────────────────────────────
app.get('/stats', requireAdmin, (req, res) => {
  const uptimeMs = Date.now() - new Date(stats.startTime).getTime();
  const uptimeHours = (uptimeMs / 1000 / 60 / 60).toFixed(1);
  res.json({
    version: BOT_VERSION,
    uptime: `${uptimeHours}h`,
    startTime: stats.startTime,
    mensajesRecibidos: stats.messagesReceived,
    leadsCapturados: stats.leadsCapturados,
    escalaciones: stats.escalaciones,
    erroresClaude: stats.erroresClaude,
    conversacionesEnMemoria: Object.keys(memoryHistory).length,
    redis: redisClient ? 'conectado' : 'memoria',
    whatsappApiVersion: WHATSAPP_API_VERSION,
    abierto: isBusinessHours(),
  });
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`911reparame Bot v${BOT_VERSION} corriendo en puerto ${PORT}`);
  console.log(`WhatsApp API: ${WHATSAPP_API_VERSION} | Redis: ${redisClient ? 'sí' : 'no'}`);
  await getPriceData();
});
