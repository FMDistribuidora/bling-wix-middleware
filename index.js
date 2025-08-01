// index.js - Bling-Wix Middleware API
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let accessToken = null;
let refreshToken = process.env.REFRESH_TOKEN || null;

// Função para autenticar no Bling
async function autenticarBling() {
    const basicAuth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');
    let data;

    try {
        if (refreshToken) {
            data = qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                redirect_uri: process.env.REDIRECT_URI
            });
            console.log('🔄 Usando refresh_token...');
        } else {
            data = qs.stringify({
                grant_type: 'authorization_code',
                code: process.env.AUTH_CODE,
                redirect_uri: process.env.REDIRECT_URI
            });
            console.log('🆕 Usando AUTH_CODE...');
        }

        const response = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', data, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${basicAuth}`
            }
        });

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;

        console.log('✅ Autenticação bem-sucedida!');
        console.log('🔑 REFRESH_TOKEN:', refreshToken);
        
    } catch (error) {
        console.error('❌ Erro na autenticação:', error.response?.data || error.message);
        throw error;
    }
}

// Função para buscar produtos do Bling
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

// Função para enviar para o Wix
async function enviarParaWix(estoque) {
    const response = await axios.post(process.env.WIX_ENDPOINT, estoque);
    return response.data;
}

// Endpoint para autenticar (original que funcionava)
app.get('/autenticar', async (req, res) => {
    try {
        await autenticarBling();
        res.json({ 
            sucesso: true,
            mensagem: 'Autenticação realizada com sucesso!',
            refresh_token: refreshToken,
            instrucoes: [
                '1. Copie o refresh_token acima',
                '2. Vá ao Render > Environment Variables',
                '3. Cole no campo REFRESH_TOKEN',
                '4. REMOVA o AUTH_CODE (deixe vazio)',
                '5. Salve as alterações'
            ]
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ 
            erro: e.message,
            dica: 'Verifique AUTH_CODE ou REFRESH_TOKEN'
        });
    }
});

// Endpoint para sincronizar estoque (original que funcionava)
app.get('/enviar-wix', async (req, res) => {
    try {
        await autenticarBling();
        const estoque = await buscarProdutosBling();
        
        if (estoque.length === 0) {
            return res.json({ mensagem: "Nenhum produto com estoque positivo." });
        }
        
        const respostaWix = await enviarParaWix(estoque);
        res.json({ 
            sucesso: true, 
            enviados: estoque.length, 
            respostaWix 
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ erro: e.message });
    }
});

// Endpoint callback para OAuth
app.get('/callback', async (req, res) => {
    const { code, error } = req.query;
    
    if (error) {
        return res.status(400).send(`<h2>❌ Erro: ${error}</h2>`);
    }
    
    if (!code) {
        return res.status(400).send('<h2>❌ Nenhum código recebido</h2>');
    }

    try {
        const basicAuth = Buffer.from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`).toString('base64');
        
        const data = qs.stringify({
            grant_type: 'authorization_code',
            code: code,
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
        
        res.send(`
            <h2>✅ REFRESH_TOKEN Gerado!</h2>
            <p><strong>Copie este token:</strong></p>
            <textarea style="width: 100%; height: 80px;">${refreshToken}</textarea>
            <h3>Próximos passos:</h3>
            <ol>
                <li>Copie o token acima</li>
                <li>Configure no Render como REFRESH_TOKEN</li>
                <li>Remova o AUTH_CODE</li>
                <li>Teste: <a href="/enviar-wix">/enviar-wix</a></li>
            </ol>
        `);
        
    } catch (error) {
        console.error(error);
        res.status(500).send(`<h2>❌ Erro ao gerar token</h2><p>${error.message}</p>`);
    }
});

// Página inicial
app.get('/', (req, res) => {
    const clientId = process.env.CLIENT_ID || 'CLIENT_ID_NOT_SET';
    const hasRefreshToken = refreshToken ? '✅ Configurado' : '❌ Não configurado';
    
    res.send(`
        <h1>🔄 Bling-Wix Middleware API</h1>
        <h2>📊 Status: Online</h2>
        <p><strong>REFRESH_TOKEN:</strong> ${hasRefreshToken}</p>
        
        <h3>🔗 Endpoints:</h3>
        <ul>
            <li><a href="/autenticar">🔐 Autenticar Bling</a></li>
            <li><a href="/enviar-wix">📦 Enviar para Wix</a></li>
        </ul>
        
        <h3>🚀 Gerar AUTH_CODE:</h3>
        <p><a href="https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=https://bling-wix-middleware.onrender.com/callback&state=bling_wix_state" target="_blank">Autorizar Bling</a></p>
        
        <hr>
        <p><small>v1.0 - FMDistribuidora</small></p>
    `);
});

app.listen(PORT, () => {
    console.log(`API de sincronização rodando na porta ${PORT}`);
});
