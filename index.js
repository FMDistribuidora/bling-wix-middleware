require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
app.use(express.json());

let accessToken = null;
let refreshToken = null;

// Função utilitária para aguardar o tempo especificado (em ms)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// 🔁 ENVIA PARA WIX (com paginação e delay)
app.get('/enviar-wix', async (req, res) => {
  if (!accessToken) return res.status(401).send("Token não autenticado. Acesse /autenticar primeiro");

  try {
    console.log('📌 Token usado:', accessToken);

    let todosProdutos = [];
    let offset = 0;
    const limit = 50;
    let maisProdutos = true;

    // Paginação para buscar todos os produtos, respeitando o limite de requisições
    while (maisProdutos) {
      const produtosResp = await axios.get(
        `https://www.bling.com.br/Api/v3/produtos?limit=${limit}&offset=${offset}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'User-Agent': 'bling-wix-middleware'
          }
        }
      );

      const produtos = produtosResp.data.data;
      if (!produtos || !Array.isArray(produtos)) {
        console.error("❌ Estrutura inesperada da resposta do Bling:", produtosResp.data);
        return res.status(500).send("Erro: estrutura inesperada da resposta do Bling.");
      }

      todosProdutos = todosProdutos.concat(produtos);

      if (produtos.length < limit) {
        maisProdutos = false;
      } else {
        offset += limit;
        await sleep(400); // Aguarda 400ms antes da próxima requisição
      }
    }

    console.log("📦 Todos os produtos recebidos do Bling:", todosProdutos.length);

    const estoque = todosProdutos
      .filter(p => Number(p.estoque?.saldoVirtualTotal || 0) > 0)
      .map(p => ({
        codigo: p.codigo,
        descricao: p.nome,
        estoque: p.estoque.saldoVirtualTotal
      }));

    if (estoque.length === 0) {
      console.log("🚫 Nenhum produto com estoque positivo encontrado. Nada enviado ao Wix.");
      return res.status(200).send("Nenhum produto com estoque positivo encontrado.");
    }

    console.log("📤 Enviando para o Wix:", estoque.length);

    try {
      const response = await axios.post('https://www.fmpapeisdeparede.com.br/_functions/salvarEstoque', estoque);

      console.log("✅ Resposta do Wix:", response.data);
      res.json({ enviado: estoque.length, respostaWix: response.data });
    } catch (erro) {
      console.error("❌ Erro ao enviar para o Wix:", erro.response?.data || erro.message);
      res.status(500).send("Erro ao enviar produtos.");
      return;
    }

  } catch (err) {
    console.error("❌ Erro ao buscar/enviar produtos:", err.response?.status, err.response?.data || err.message);
    res.status(500).send("Erro ao enviar produtos.");
  }
});

// 🚀 ROTA PÚBLICA PARA CONSULTAR ESTOQUE
app.get('/estoque', async (req, res) => {
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
      return res.status(500).send("Erro: estrutura inesperada da resposta do Bling.");
    }

    const estoque = produtos.data.data
      .filter(p => Number(p.estoque?.saldoVirtualTotal || 0) > 0)
      .map(p => ({
        codigo: p.codigo,
        descricao: p.nome,
        estoque: p.estoque.saldoVirtualTotal
      }));

    res.json(estoque);
  } catch (err) {
    console.error("❌ Erro ao buscar estoque:", err.response?.status, err.response?.data || err.message);
    res.status(500).send("Erro ao buscar estoque.");
  }
});

// PORTA
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware rodando na porta ${PORT}`);
  console.log("==> https://bling-wix-middleware.onrender.com");
});
