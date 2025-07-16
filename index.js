require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(express.json());

let accessToken = null;

app.get('/autenticar', (req, res) => {
  const state = 'bling_wix_state';
  const authUrl = `https://www.bling.com.br/api/v3/oauth/authorize?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send("❌ Código de autorização ausente.");
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

app.get('/enviar-wix', async (req, res) => {
  if (!accessToken) {
    return res.status(401).send("❌ Token não autenticado. Acesse /autenticar primeiro.");
  }

  try {
    const produtosResponse = await axios.get('https://www.bling.com.br/api/v3/produtos', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });

    const produtos = produtosResponse.data?.data;

    if (!Array.isArray(produtos)) {
      throw new Error("Formato de dados inesperado dos produtos.");
    }

    const estoque = produtos
      .filter(p => Number(p.estoqueAtual || 0) > 0)
      .map(p => ({
        codigo: p.codigo,
        descricao: p.descricao,
        estoque: p.estoqueAtual
      }));

    const wixResponse = await axios.post(process.env.WIX_ENDPOINT, estoque, {
      headers: { 'Content-Type': 'application/json' }
    });

    console.log("✅ Produtos enviados com sucesso para o Wix!");
    res.json({ enviado: estoque.length, respostaWix: wixResponse.data });
  } catch (err) {
    console.error("❌ Erro ao buscar/enviar produtos:", err.response?.data || err.message);
    res.status(500).send("Erro ao enviar produtos.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware rodando na porta ${PORT}`);
});
