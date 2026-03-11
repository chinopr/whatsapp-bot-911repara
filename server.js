const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();
const app = express();
app.use(express.json());
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tu_token_verificacion';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const client = new Anthropic({ apiKey: CLAUDE_API_KEY });
// Webhook GET para verificación de Meta
app.get('/webhook', (req, res) => {
  const verify_token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (verify_token === VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});
// Webhook POST para recibir mensajes
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const phone_number_id = body.entry[0].changes[0].value.metadata.phone_number_id;
      const from = body.entry[0].changes[0].value.messages[0].from;
      const msg_body = body.entry[0].changes[0].value.messages[0].text.body;
      console.log(`Mensaje de ${from}: ${msg_body}`);
      // Obtener respuesta de Claude
      const message = await client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: msg_body,
          },
        ],
      });
      const response_text = message.content[0].text;
      // Enviar respuesta a WhatsApp
      await axios.post(
        `https://graph.instagram.com/v18.0/${phone_number_id}/messages?access_token=${WHATSAPP_TOKEN}`,
        {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: {
            body: response_text,
          },
        }
      );
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } else {
    res.sendStatus(404);
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
```
**Archivo 3: `.env` (para Railway)**
```
WHATSAPP_TOKEN=tu_token_aqui
PHONE_NUMBER_ID=1060580410464281
VERIFY_TOKEN=tu_token_verificacion
CLAUDE_API_KEY=tu_api_key_anthropic
