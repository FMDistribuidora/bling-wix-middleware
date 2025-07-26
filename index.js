require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(express.json());

let accessToken = null;
let refreshToken = null;

// 🔐 ROTA DE AUTENTICAÇÃO
app.get('/autenticar', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    state: 'bling_wix_state'
  }).toString();

  const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?${params}`;
  console.log('🔑 Auth URL:', authUrl);
  res.redirect(authUrl);
});

// 🔁 CALLBACK
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Erro: código não encontrado na URL de callback.');

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
    refreshToken = response.data.refresh_token;
    console.log("✅ Token recebido:", accessToken);
    res.send("✅ Token salvo com sucesso!");
  } catch (error) {
    console.error("❌ Erro ao obter token:", error.response?.data || error.message);
    res.status(500).send("Erro ao autenticar com Bling.");
  }
});

// 🔁 FUNÇÃO PARA REFRESH
async function refreshAccessToken() {
  const basicAuth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');
  const data = qs.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  try {
    const response = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', data, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      }
    });

    accessToken = response.data.access_token;
    refreshToken = response.data.refresh_token;
    console.log("🔁 Token atualizado com sucesso:", accessToken);
  } catch (error) {
    console.error("❌ Erro ao atualizar token:", error.response?.data || error.message);
  }
}

// 🔁 ENVIA PARA WIX
app.get('/enviar-wix', async (req, res) => {
  if (!accessToken) return res.status(401).send("Token não autenticado. Acesse /autenticar primeiro");

  try {
  const produtos = await axios.get('https://www.bling.com.br/Api/v3/produtos?limit=50&offset=0', {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'bling-wix-middleware'
  }
});

    if (!produtos.data || !Array.isArray(produtos.data.data)) {
      console.error("❌ Estrutura inesperada da resposta do Bling:", produtos.data);
      return res.status(500).send("Erro: estrutura inesperada da resposta do Bling.");
    }

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
    if (err.response?.status === 401) {
      console.warn("⚠️ Token expirado. Tentando refresh...");
      await refreshAccessToken();
      return res.redirect('/enviar-wix');
    }

    console.error("❌ Erro ao buscar/enviar produtos:", err.response?.status, err.response?.data || err.message);
    res.status(500).send("Erro ao enviar produtos.");
  }
});

// PORTA
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware rodando na porta ${PORT}`);
  console.log("==> https://bling-wix-middleware.onrender.com");
});
