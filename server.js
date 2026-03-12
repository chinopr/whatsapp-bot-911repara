const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
require('dotenv').config();

// Redis opcional — si REDIS_URL está configurado se usa, si no cae a memoria
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

const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const CLAUDE_API_KEY  = process.env.CLAUDE_API_KEY;
const GOOGLE_API_KEY  = process.env.GOOGLE_API_KEY;
const SHEET_ID        = process.env.SHEET_ID;

const WHATSAPP_API_VERSION = 'v21.0';
const HISTORY_TTL_SECONDS  = 60 * 60 * 24; // 24 horas
const MAX_HISTORY_MESSAGES = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX_MSGS  = 10;        // máx mensajes por minuto por usuario

const MAPS_URL = 'https://www.google.com/maps/dir//911+repara.me,+Walgreens,+Carretera+2+Int+Carretera+149+Frente+Farmacia,+Manat%C3%AD,+00674/@18.436519,-66.4390542,15z/data=!4m8!4m7!1m0!1m5!1m1!1s0x8c031780deae45f3:0x13d55e015794b54e!2m2!1d-66.475142!2d18.431694?entry=ttu&g_ep=EgoyMDI2MDMwOS4wIKXMDSoASAFQAw%3D%3D';

const client = new Anthropic({ apiKey: CLAUDE_API_KEY });

// ─── Historial de conversación (Redis o memoria) ─────────────────────────────
const memoryHistory = {};

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

// ─── Rate limiting (en memoria) ──────────────────────────────────────────────
const rateLimitMap = {};

function isRateLimited(userId) {
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

// ─── Google Sheets — guardar lead ────────────────────────────────────────────
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
      resource: { values: [[fecha, nombre, telefono, servicio, whatsappNum, 'Nuevo']] }
    });
    console.log('Lead guardado:', nombre, telefono, servicio);
  } catch (err) {
    console.error('Error guardando lead:', err.message);
  }
}

// ─── Google Sheets — precios ─────────────────────────────────────────────────
let sheetCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchSheetData(sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}?key=${GOOGLE_API_KEY}`;
  const res = await axios.get(url);
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

async function getPriceData() {
  const now = Date.now();
  if (sheetCache && (now - cacheTimestamp) < CACHE_TTL_MS) return sheetCache;
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

// ─── Búsqueda inteligente de reparaciones ────────────────────────────────────
// Alias de marcas y modelos comunes para detectar del mensaje del cliente
const BRAND_ALIASES = {
  apple:      ['apple', 'iphone', 'ipad', 'macbook', 'mac'],
  samsung:    ['samsung', 'galaxy', 's24', 's23', 's22', 's21', 's20', 's10', 'note', 'a54', 'a34', 'a15'],
  google:     ['google', 'pixel'],
  motorola:   ['motorola', 'moto'],
  lg:         ['lg'],
  sony:       ['sony', 'xperia'],
  huawei:     ['huawei'],
  oneplus:    ['oneplus', 'one plus'],
  nintendo:   ['nintendo', 'switch'],
  playstation:['playstation', 'ps4', 'ps5', 'ps3'],
  xbox:       ['xbox'],
};

function filterRepairsByMessage(reparaciones, conversationText) {
  const msg = conversationText.toLowerCase();

  // Detectar marca
  let brandAliases = null;
  for (const [, aliases] of Object.entries(BRAND_ALIASES)) {
    if (aliases.some(a => msg.includes(a))) {
      brandAliases = aliases;
      break;
    }
  }

  let filtered = reparaciones;

  if (brandAliases) {
    // Filtrar por marca
    filtered = reparaciones.filter(r =>
      brandAliases.some(a =>
        r['Marca'].toLowerCase().includes(a) ||
        r['Modelo'].toLowerCase().includes(a)
      )
    );

    // Refinar por modelo si se detectan palabras con número (ej: s24, iphone 13, a54)
    const modelWords = msg.match(/\b(iphone\s*\d+[\w\s]*|s\d+\s*\w*|pixel\s*\d+\w*|galaxy\s*\w+|ipad\s*\w*|note\s*\d+|a\d+|ps\d|xbox\s*\w*|switch)\b/gi) || [];
    if (modelWords.length > 0) {
      const modelFiltered = filtered.filter(r =>
        modelWords.some(w => r['Modelo'].toLowerCase().includes(w.toLowerCase().trim()))
      );
      if (modelFiltered.length > 0) filtered = modelFiltered;
    }
  }

  // Si no se detectó nada relevante, devolver muestra general (un servicio por modelo)
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

function buildPriceContext(data, userMessage = '') {
  let ctx = '';
  const repsActivas = data.reparaciones.filter(r => r['Notas / Estado'] !== 'Descontinuado');

  if (repsActivas.length > 0) {
    // Usar búsqueda inteligente si hay mensaje del cliente
    const relevant = userMessage
      ? filterRepairsByMessage(repsActivas, userMessage)
      : repsActivas.slice(0, 80);

    ctx += '\nREPARACIONES:\n';
    relevant.forEach(r => {
      // El Sheet ya incluye el símbolo $ en las celdas — no agregar otro
      const min = r['Precio Mín ($)'].replace(/^\$/, '');
      const max = r['Precio Máx ($)'].replace(/^\$/, '');
      ctx += `- ${r['Dispositivo']} ${r['Marca']} ${r['Modelo']} - ${r['Servicio']}: $${min}-$${max} | ${r['Tiempo Estim.']}\n`;
    });
  }

  const ventasDisp = data.ventas.filter(v => v['Disponibilidad'] === 'Sí');
  if (ventasDisp.length > 0) {
    ctx += '\nEQUIPOS EN VENTA:\n';
    ventasDisp.forEach(v => {
      const precio = v['Precio ($)'].replace(/^\$/, '');
      ctx += `- ${v['Tipo']} ${v['Marca']} ${v['Modelo']} - ${v['Condición']} - $${precio}\n`;
    });
  }

  const accDisp = data.accesorios.filter(a => a['Disponibilidad'] === 'Sí');
  if (accDisp.length > 0) {
    ctx += '\nACCESORIOS:\n';
    accDisp.forEach(a => {
      const precio = a['Precio ($)'].replace(/^\$/, '');
      ctx += `- ${a['Tipo']}: ${a['Descripción']} - $${precio}\n`;
    });
  }

  return ctx;
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(priceContext) {
  const now = new Date().toLocaleString('es-PR', {
    timeZone: 'America/Puerto_Rico',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  return `Eres Alex, asistente virtual de 911reparame en Puerto Rico. Responde SIEMPRE en español, amigable y conciso (max 3-4 oraciones). Usa emojis ocasionalmente.

FECHA Y HORA ACTUAL (Puerto Rico): ${now}

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
- Cuando el cliente mencione un dispositivo o servicio, comparte enseguida el rango de precio ("entre $X y $Y") de forma natural y amigable
- Para afinar la cotización pide: marca, modelo exacto y descripción del problema
- Nunca inventes precios que no estén en la lista
- Si hay varios modelos similares, muestra los rangos disponibles para que el cliente elija
- Si el servicio no está en la lista di que un asesor confirmará el precio

CAPTURA DE LEADS:
- Cuando el cliente quiera proceder, pide su nombre y teléfono
- Al recibir nombre y teléfono, incluye al FINAL de tu respuesta (invisible para el cliente) la siguiente etiqueta exacta:
  [LEAD: nombre=NOMBRE_AQUI, telefono=TELEFONO_AQUI, servicio=SERVICIO_AQUI]
- Esta etiqueta es solo para el sistema, no la menciones ni expliques al cliente

UBICACIÓN Y DIRECCIONES:
- Cuando el cliente pregunte cómo llegar, la dirección, la ubicación o dónde están, incluye al FINAL de tu respuesta la etiqueta exacta: [UBICACION]
- El sistema enviará automáticamente un botón interactivo con el enlace a Google Maps
- No incluyas URLs largas en tu texto, solo la etiqueta [UBICACION]

OTRAS INSTRUCCIONES:
- Si no sabes algo di que un asesor confirmará pronto
- Si preguntan por horario de sábado indica que es variable y que llamen al 787-996-6976 para confirmar
- Usa la FECHA Y HORA ACTUAL para responder preguntas sobre si estamos abiertos ahora mismo

PRECIOS ACTUALIZADOS:
${priceContext}`;
}

// ─── Enviar mensaje de texto WhatsApp ────────────────────────────────────────
async function sendWhatsAppMessage(phoneNumberId, to, text) {
  await axios.post(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ─── Enviar botón "Como llegar" con enlace a Google Maps ──────────────────────
async function sendLocationButton(phoneNumberId, to) {
  await axios.post(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: {
          text: '📍 *Carretera 149, intersección con Carretera 2*\nFrente a Manatí Plaza Shopping Center\n\nToca el botón para abrir Google Maps:',
        },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: 'Como llegar 📍',
            url: MAPS_URL,
          },
        },
      },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ─── Webhook verificación ─────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const verify_token = req.query['hub.verify_token'];
  const challenge    = req.query['hub.challenge'];
  if (verify_token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Webhook mensajes ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry          = req.body?.entry?.[0];
    const changes        = entry?.changes?.[0];
    const message        = changes?.value?.messages?.[0];
    if (!message) return;

    const from            = message.from;
    const phone_number_id = changes?.value?.metadata?.phone_number_id;

    // ── Rate limiting ──────────────────────────────────────────────────────
    if (isRateLimited(from)) {
      console.warn('Rate limit alcanzado para:', from);
      await sendWhatsAppMessage(phone_number_id, from,
        'Estás enviando mensajes muy rápido. Por favor espera un momento antes de continuar. 🙏');
      return;
    }

    // ── Solo procesar texto; responder amablemente a otros tipos ──────────
    if (message.type !== 'text') {
      console.log(`Mensaje tipo "${message.type}" de ${from} — no soportado`);
      await sendWhatsAppMessage(phone_number_id, from,
        'Por el momento solo puedo procesar mensajes de texto 📝. Descríbeme tu consulta o el problema con tu equipo y con gusto te ayudo. 😊');
      return;
    }

    const msg_body = message.text.body;
    console.log('Mensaje de', from, ':', msg_body);

    // ── Historial ─────────────────────────────────────────────────────────
    let history = await getHistory(from);
    history.push({ role: 'user', content: msg_body });
    if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(-MAX_HISTORY_MESSAGES);

    // ── Llamada a Claude ──────────────────────────────────────────────────
    const priceData    = await getPriceData();
    const priceContext = buildPriceContext(priceData, msg_body);
    const systemPrompt = buildSystemPrompt(priceContext);

    const aiResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: history,
    });
    let reply = aiResponse.content[0].text;

    // ── Detectar y guardar lead ───────────────────────────────────────────
    const leadMatch = reply.match(/\[LEAD:\s*nombre=([^,\]]+),\s*telefono=([^,\]]+),\s*servicio=([^\]]+)\]/i);
    if (leadMatch) {
      const [, nombre, telefono, servicio] = leadMatch;
      reply = reply.replace(leadMatch[0], '').trim();
      await saveLead(nombre.trim(), telefono.trim(), servicio.trim(), from);
    }

    // ── Detectar si el bot quiere enviar botón de ubicación ───────────────
    const sendLocation = /\[UBICACION\]/i.test(reply);
    reply = reply.replace(/\[UBICACION\]/gi, '').trim();

    // ── Guardar historial y enviar respuesta ──────────────────────────────
    history.push({ role: 'assistant', content: reply });
    await saveHistory(from, history);
    await sendWhatsAppMessage(phone_number_id, from, reply);
    if (sendLocation) await sendLocationButton(phone_number_id, from);
    console.log('Respuesta enviada a', from, sendLocation ? '+ botón ubicación' : '');
  } catch (err) {
    console.error('Error:', err.message, JSON.stringify(err?.response?.data));
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    negocio: '911reparame Bot',
    version: '3.0',
    whatsapp_api: WHATSAPP_API_VERSION,
    redis: redisClient ? 'conectado' : 'memoria',
  });
});

// ─── Debug precios ────────────────────────────────────────────────────────────
// Uso: /debug-prices?q=samsung+s24+ultra
app.get('/debug-prices', async (req, res) => {
  const query   = req.query.q || '';
  const data    = await getPriceData();
  const context = buildPriceContext(data, query);
  res.json({
    totales: {
      reparaciones: data.reparaciones.length,
      ventas: data.ventas.length,
      accesorios: data.accesorios.length,
    },
    query_usada: query || '(ninguna — muestra general)',
    contexto_enviado_al_bot: context,
    muestra_reparaciones: data.reparaciones.slice(0, 5),
  });
});

// ─── Inicio ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`911reparame Bot v3.0 corriendo en puerto ${PORT}`);
  console.log(`WhatsApp API: ${WHATSAPP_API_VERSION}`);
  await getPriceData();
});
