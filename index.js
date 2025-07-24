require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(express.json());

let accessToken = null;

// 🔐 ROTA DE AUTENTICAÇÃO
app.get('/autenticar', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    state: 'bling_wix_state'
  }).toString();

  const authUrl = `https://www.bling.com.br/api/v3/oauth/authorize?${params}`;
  
  console.log('🔑 Auth URL:', authUrl); // Apenas um console
  res.redirect(authUrl);                // Apenas um redirect
});

// 🔁 CALLBACK
app.get('/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send('Erro: código não encontrado na URL de callback.');
  }

  const basicAuth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');
  const data = qs.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.REDIRECT_URI
  });

  try {
    const response = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', data, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      }
    });

    accessToken = response.data.access_token;
    console.log("✅ Token recebido:", accessToken);
    res.send("✅ Token salvo com sucesso!");
  } catch (error) {
    console.error("❌ Erro ao obter token:", error.response?.data || error.message);
    res.status(500).send("Erro ao autenticar com Bling.");
  }
});

// 🔁 ENVIA PARA WIX
app.get('/enviar-wix', async (req, res) => {
  if (!accessToken) {
    return res.status(401).send("Token não autenticado. Acesse /autenticar primeiro");
  }

  try {
    const produtos = await axios.get('https://www.bling.com.br/api/v3/produtos', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });

    const estoque = produtos.data.data
      .filter(p => Number(p.estoqueAtual || 0) > 0)
      .map(p => ({
        codigo: p.codigo,
        descricao: p.descricao,
        estoque: p.estoqueAtual
      }));

    const wixResponse = await axios.post(process.env.WIX_ENDPOINT, estoque, {
      headers: { 'Content-Type': 'application/json' }
    });

    res.json({ enviado: estoque.length, respostaWix: wixResponse.data });
  } catch (err) {
    console.error("❌ Erro ao buscar/enviar produtos:", err.response?.data || err.message);
    res.status(500).send("Erro ao enviar produtos.");
  }
});

// PORTA
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware rodando na porta ${PORT}`);
  console.log("==> Your service is live 🎉");
  console.log("==> Available at your primary URL https://bling-wix-middleware.onrender.com");
});
