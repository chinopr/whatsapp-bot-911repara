const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const CLAUDE_API_KEY  = process.env.CLAUDE_API_KEY;
const GOOGLE_API_KEY  = process.env.GOOGLE_API_KEY;
const SHEET_ID        = process.env.SHEET_ID;

const client = new Anthropic({ apiKey: CLAUDE_API_KEY });

// ── HISTORIAL DE CONVERSACIONES ──────────────────────────────────────────
const conversationHistory = {};

// ── CACHE DE PRECIOS (se refresca cada 1 hora) ───────────────────────────
let sheetCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

async function fetchSheetData(sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName)}?key=${GOOGLE_API_KEY}`;
  const res = await axios.get(url);
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

async function getPriceData() {
  const now = Date.now();
  if (sheetCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return sheetCache;
  }
  console.log('🔄 Actualizando cache de precios desde Google Sheets...');
  try {
    const [reparaciones, ventas, accesorios] = await Promise.all([
      fetchSheetData('Reparaciones'),
      fetchSheetData('Ventas'),
      fetchSheetData('Accesorios'),
    ]);
    sheetCache = { reparaciones, ventas, accesorios };
    cacheTimestamp = now;
    console.log(`✅ Cache actualizado: ${reparaciones.length} reparaciones, ${ventas.length} ventas, ${accesorios.length} accesorios`);
    return sheetCache;
  } catch (err) {
    console.error('❌ Error leyendo Google Sheets:', err.message);
    return sheetCache || { reparaciones: [], ventas: [], accesorios: [] };
  }
}

function buildPriceContext(data) {
  let ctx = '';

  // Reparaciones activas
  const repsActivas = data.reparaciones.filter(r =>
    r['Notas / Estado'] !== 'Descontinuado'
  );
  if (repsActivas.length > 0) {
    ctx += '\n=== REPARACIONES ===\n';
    const byService = {};
    repsActivas.forEach(r => {
      const key = `${r['Dispositivo']} ${r['Marca']} ${r['Modelo']} - ${r['Servicio']}`;
      byService[key] = {
        min: r['Precio Mín ($)'],
        max: r['Precio Máx ($)'],
        tiempo: r['Tiempo Estim.'],
      };
    });
    Object.entries(byService).slice(0, 120).forEach(([k, v]) => {
      ctx += `• ${k}: $${v.min}-$${v.max} | ${v.tiempo}\n`;
    });
    ctx += '(Si no encuentras el modelo exacto, da un estimado basado en modelos similares)\n';
  }

  // Ventas disponibles
  const ventasDisp = data.ventas.filter(v => v['Disponibilidad'] === 'Sí');
  if (ventasDisp.length > 0) {
    ctx += '\n=== EQUIPOS EN VENTA (DISPONIBLES) ===\n';
    ventasDisp.forEach(v => {
      ctx += `• ${v['Tipo']} ${v['Marca']} ${v['Modelo']} - ${v['Condición']} - $${v['Precio ($)']}\n`;
    });
  }

  const ventasBajoPedido = data.ventas.filter(v => v['Disponibilidad'] === 'Bajo pedido');
  if (ventasBajoPedido.length > 0) {
    ctx += '\n=== EQUIPOS BAJO PEDIDO ===\n';
    ventasBajoPedido.forEach(v => {
      ctx += `• ${v['Tipo']} ${v['Marca']} ${v['Modelo']} - $${v['Precio ($)']}\n`;
    });
  }

  // Accesorios disponibles
  const accDisp = data.accesorios.filter(a => a['Disponibilidad'] === 'Sí');
  if (accDisp.length > 0) {
    ctx += '\n=== ACCESORIOS Y PREPAGADOS ===\n';
    accDisp.forEach(a => {
      ctx += `• ${a['Tipo']}: ${a['Descripción']} - $${a['Precio ($)']}\n`;
    });
  }

  return ctx;
}

// ── SYSTEM PROMPT ────────────────────────────────────────────────────────
function buildSystemPrompt(priceContext) {
  return `Eres Alex, el asistente virtual de 911reparame, un negocio de tecnología en Puerto Rico.
Responde SIEMPRE en español, de forma amigable y concisa (máximo 3-4 oraciones).
Usa emojis ocasionalmente para ser más cercano 📱.

SERVICIOS QUE OFRECEMOS:
- Reparación de celulares, tabletas y consolas
- Venta de equipos nuevos y usados
- Servicios prepagados (recargas, planes, activaciones)
- Accesorios y tecnología

INSTRUCCIONES:
- Para cotizar reparaciones, pide: marca, modelo exacto y descripción del problema
- Nunca inventes precios que no estén en la lista — si no está, di que consultarás y responderás pronto
- Si el equipo no está en la lista, da un estimado basado en modelos similares y acláralo
- Para ventas, confirma disponibilidad con el cliente antes de comprometerte
- Si el cliente quiere proceder, pide nombre y número para que un asesor le contacte
- Si no sabes algo, sé honesto: "Déjame verificarlo y te confirmo enseguida"

PRECIOS ACTUALIZADOS:
${priceContext}`;
}

// ── WEBHOOK GET — Verificación de Meta ──────────────────────────────────
app.get('/webhook', (req, res) => {
  const verify_token = req.query['hub.verify_token'];
  const challenge    = req.query['hub.challenge'];
  if (verify_token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.send(challenge);
  } else {
    console.log('❌ Token incorrecto');
    res.sendStatus(403);
  }
});

// ── WEBHOOK POST — Recibir mensajes ──────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder a Meta inmediatamente

  try {
    const entry          = req.body?.entry?.[0];
    const changes        = entry?.changes?.[0];
    const message        = changes?.value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const from            = message.from;
    const msg_body        = message.text.body;
    const phone_number_id = changes?.value?.metadata?.phone_number_id;

    console.log(`📩 Mensaje de ${from}: ${msg_body}`);

    // Historial por cliente (últimos 10 mensajes)
    if (!conversationHistory[from]) conversationHistory[from] = [];
    conversationHistory[from].push({ role: 'user', content: msg_body });
    if (conversationHistory[from].length > 10) {
      conversationHistory[from] = conversationHistory[from].slice(-10);
    }

    // Obtener precios actualizados desde Sheets
    const priceData    = await getPriceData();
    const priceContext = buildPriceContext(priceData);
    const systemPrompt = buildSystemPrompt(priceContext);

    // Llamar a Claude
    const aiResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: conversationHistory[from],
    });

    const reply = aiResponse.content[0].text;
    conversationHistory[from].push({ role: 'assistant', content: reply });

    // Enviar respuesta por WhatsApp
    await axios.post(
      `https://graph.facebook.com/v18.0/${phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: reply },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✅ Respuesta enviada a ${from}`);

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
});

// ── HEALTH CHECK ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', negocio: '911reparame Bot', version: '2.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 911reparame Bot corriendo en puerto ${PORT}`);
  await getPriceData(); // Pre-cargar precios al iniciar
});
