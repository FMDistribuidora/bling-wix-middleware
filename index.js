// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 10000;

// Funções de autenticação e sincronização (igual ao script anterior)
let accessToken = null;
let refreshToken = null;

async function autenticarBling() {
    const basicAuth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');
    const data = qs.stringify({
        grant_type: 'authorization_code',
        code: process.env.AUTH_CODE,
        redirect_uri: process.env.REDIRECT_URI
    });

    const response = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', data, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${basicAuth}`
        }
    });

    accessToken = response.data.access_token;
    refreshToken = response.data.refresh_token;
}

async function buscarProdutosBling() {
    let todosProdutos = [];
    let offset = 0;
    const limit = 50;
    let maisProdutos = true;

    while (maisProdutos) {
        const produtosResp = await axios.get(
            `https://www.bling.com.br/Api/v3/produtos?limit=${limit}&offset=${offset}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                    'User-Agent': 'bling-wix-sync'
                }
            }
        );

        const produtos = produtosResp.data.data;
        if (!produtos || !Array.isArray(produtos)) break;

        todosProdutos = todosProdutos.concat(produtos);

        if (produtos.length < limit) {
            maisProdutos = false;
        } else {
            offset += limit;
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }
    return todosProdutos
        .filter(p => Number(p.estoque?.saldoVirtualTotal || 0) > 0)
        .map(p => ({
            codigo: p.codigo,
            descricao: p.nome,
            estoque: p.estoque.saldoVirtualTotal
        }));
}

async function enviarParaWix(estoque) {
    const response = await axios.post(
        process.env.WIX_FUNCTION_URL,
        estoque
    );
    return response.data;
}

// Endpoint para sincronização
app.get('/sync', async (req, res) => {
    try {
        await autenticarBling();
        const estoque = await buscarProdutosBling();
        if (estoque.length === 0) {
            return res.json({ mensagem: "Nenhum produto com estoque positivo." });
        }
        const respostaWix = await enviarParaWix(estoque);
        res.json({ sucesso: true, enviados: estoque.length, respostaWix });
    } catch (e) {
        console.error(e);
        res.status(500).json({ erro: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`API de sincronização rodando na porta ${PORT}`);
});
