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
const conversationHistory = {};
let sheetCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

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

function buildPriceContext(data) {
  let ctx = '';
  const repsActivas = data.reparaciones.filter(r => r['Notas / Estado'] !== 'Descontinuado');
  if (repsActivas.length > 0) {
    ctx += '\nREPARACIONES:\n';
    const byService = {};
    repsActivas.forEach(r => {
      const key = `${r['Dispositivo']} ${r['Marca']} ${r['Modelo']} - ${r['Servicio']}`;
      byService[key] = { min: r['Precio Mín ($)'], max: r['Precio Máx ($)'], tiempo: r['Tiempo Estim.'] };
    });
    Object.entries(byService).slice(0, 120).forEach(([k, v]) => {
      ctx += `- ${k}: $${v.min}-$${v.max} | ${v.tiempo}\n`;
    });
  }
  const ventasDisp = data.ventas.filter(v => v['Disponibilidad'] === 'Sí');
  if (ventasDisp.length > 0) {
    ctx += '\nEQUIPOS EN VENTA:\n';
    ventasDisp.forEach(v => { ctx += `- ${v['Tipo']} ${v['Marca']} ${v['Modelo']} - ${v['Condición']} - $${v['Precio ($)']}\n`; });
  }
  const accDisp = data.accesorios.filter(a => a['Disponibilidad'] === 'Sí');
  if (accDisp.length > 0) {
    ctx += '\nACCESORIOS:\n';
    accDisp.forEach(a => { ctx += `- ${a['Tipo']}: ${a['Descripción']} - $${a['Precio ($)']}\n`; });
  }
  return ctx;
}

function buildSystemPrompt(priceContext) {
  return `Eres Alex, asistente virtual de 911reparame en Puerto Rico. Responde SIEMPRE en español, amigable y conciso (max 3-4 oraciones). Usa emojis ocasionalmente.

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

INSTRUCCIONES:
- Para cotizar pide: marca, modelo y problema
- Nunca inventes precios que no estén en la lista
- Si el cliente quiere proceder pide nombre y teléfono
- Si no sabes algo di que un asesor confirmará pronto
- Si preguntan por horario de sábado indica que es variable y que llamen al 787-996-6976 para confirmar

PRECIOS ACTUALIZADOS:
${priceContext}`;
}

app.get('/webhook', (req, res) => {
  const verify_token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (verify_token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const from = message.from;
    const msg_body = message.text.body;
    const phone_number_id = changes?.value?.metadata?.phone_number_id;
    console.log('Mensaje de', from, ':', msg_body);
    if (!conversationHistory[from]) conversationHistory[from] = [];
    conversationHistory[from].push({ role: 'user', content: msg_body });
    if (conversationHistory[from].length > 10) conversationHistory[from] = conversationHistory[from].slice(-10);
    const priceData = await getPriceData();
    const priceContext = buildPriceContext(priceData);
    const systemPrompt = buildSystemPrompt(priceContext);
    const aiResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: conversationHistory[from],
    });
    const reply = aiResponse.content[0].text;
    conversationHistory[from].push({ role: 'assistant', content: reply });
    await axios.post(
      `https://graph.facebook.com/v17.0/${phone_number_id}/messages`,
      { messaging_product: 'whatsapp', to: from, type: 'text', text: { body: reply } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log('Respuesta enviada a', from);
  } catch (err) {
    console.error('Error:', err.message, JSON.stringify(err?.response?.data));
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', negocio: '911reparame Bot', version: '2.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('911reparame Bot corriendo en puerto', PORT);
  await getPriceData();
});
