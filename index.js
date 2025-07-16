require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(express.json());

let accessToken = null;

// 👉 Rota para iniciar autenticação com Bling
app.get('/autenticar', (req, res) => {
  const authUrl = `https://www.bling.com.br/api/v3/oauth/authorize?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}&state=blingwix123`;
  res.redirect(authUrl);
});

// 👉 Rota de callback para receber o código e trocar por token
app.get('/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    console.error("Código ausente na callback:", req.query);
    return res.status(400).send("Erro: Código ausente na URL de callback.");
  }

  const basicAuth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');

  const data = qs.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.REDIRECT_URI
  });

  try {
    const response = await axios.post(
      'https://www.bling.com.br/api/v3/oauth/token',
      data,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`
        }
      }
    );

    accessToken = response.data.access_token;
    console.log("✅ Token recebido:", accessToken);
    res.send("✅ Token salvo com sucesso!");
  } catch (error) {
    console.error("❌ Erro ao obter token:", error.response?.data || error.message);
    res.status(500).send("Erro ao autenticar com Bling.");
  }
});

// 👉 Rota para buscar produtos no Bling e enviar ao Wix
app.get('/enviar-wix', async (req, res) => {
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

// 👉 Inicia o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware rodando na porta ${PORT}`);
});
