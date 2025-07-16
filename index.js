require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(express.json());

let accessToken = null;

app.get('/autenticar', (req, res) => {
  const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}`;
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const response = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', qs.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.REDIRECT_URI,
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    accessToken = response.data.access_token;
    console.log("Token recebido:", accessToken);
    res.send("✅ Token salvo com sucesso!");
  } catch (error) {
    console.error("Erro ao obter token:", error.response?.data || error.message);
    res.status(500).send("Erro ao autenticar com Bling.");
  }
});

app.get('/enviar-wix', async (req, res) => {
  try {
    const produtos = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
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
    console.error("Erro ao buscar/enviar produtos:", err.response?.data || err.message);
    res.status(500).send("Erro ao enviar produtos.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Middleware rodando na porta ${PORT}`);
});