require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// Configurações do Bling
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const WIX_ENDPOINT = process.env.WIX_ENDPOINT;

let accessToken = null;

// Função para autenticar com o Bling usando refresh_token
async function autenticarBling() {
    if (!REFRESH_TOKEN) {
        throw new Error('REFRESH_TOKEN não configurado');
    }

    console.log('🔄 Usando refresh_token...');
    
    try {
        const response = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', 
            qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: REFRESH_TOKEN,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET
            }), 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        accessToken = response.data.access_token;
        console.log('✅ Autenticação bem-sucedida!');
        
        // Atualizar refresh_token se fornecido
        if (response.data.refresh_token) {
            console.log(`🔑 REFRESH_TOKEN: ${response.data.refresh_token}`);
        }
        
        return accessToken;
    } catch (error) {
        console.error('❌ Erro na autenticação:', error.response?.data || error.message);
        throw error;
    }
}

// Buscar produtos com estoque do Bling
async function buscarProdutosBling() {
    if (!accessToken) {
        await autenticarBling();
    }

    try {
        const response = await axios.get('https://www.bling.com.br/Api/v3/produtos', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            params: {
                limite: 100,
                pagina: 1
            }
        });

        const produtos = response.data.data || [];
        console.log(`📦 ${produtos.length} produtos encontrados`);

        // Filtrar produtos com estoque > 0
        const produtosComEstoque = produtos.filter(produto => {
            const estoque = produto.estoque?.saldoFisico || 0;
            return estoque > 0;
        });

        console.log(`✅ ${produtosComEstoque.length} produtos com estoque`);
        return produtosComEstoque;
    } catch (error) {
        console.error('❌ Erro ao buscar produtos:', error.response?.data || error.message);
        
        // Se token expirou, tentar renovar
        if (error.response?.status === 401) {
            console.log('🔄 Token expirado, renovando...');
            await autenticarBling();
            return await buscarProdutosBling();
        }
        
        throw error;
    }
}

// Enviar produtos para o Wix
async function enviarParaWix(produtos) {
    if (!WIX_ENDPOINT) {
        throw new Error('WIX_ENDPOINT não configurado');
    }

    try {
        const dadosParaEnvio = produtos.map(produto => ({
            codigo: produto.codigo,
            nome: produto.nome,
            preco: produto.preco || 0,
            estoque: produto.estoque?.saldoFisico || 0,
            descricao: produto.descricao || '',
            categoria: produto.categoria?.descricao || 'Geral'
        }));

        const response = await axios.post(WIX_ENDPOINT, {
            produtos: dadosParaEnvio
        }, {
            timeout: 30000
        });

        console.log('✅ Produtos enviados para o Wix:', dadosParaEnvio.length);
        return response.data;
    } catch (error) {
        console.error('❌ Erro ao enviar para Wix:', error.response?.data || error.message);
        throw error;
    }
}

// Rotas da API
app.get('/', (req, res) => {
    res.send(`
        <h1>🔄 Bling-Wix Middleware API</h1>
        <h2>📊 Status: Online</h2>
        <p><strong>REFRESH_TOKEN:</strong> ${REFRESH_TOKEN ? '✅ Configurado' : '❌ Não configurado'}</p>
        
        <h3>🔗 Endpoints:</h3>
        <ul>
            <li><a href="/autenticar">🔐 Autenticar Bling</a></li>
            <li><a href="/enviar-wix">📦 Enviar para Wix</a></li>
        </ul>
        
        <h3>🚀 Gerar AUTH_CODE:</h3>
        <p><a href="https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&state=bling_wix_state" target="_blank">Autorizar Bling</a></p>
        
        <hr>
        <p><small>v1.0 - FMDistribuidora</small></p>
    `);
});

// Endpoint para autenticar com o Bling
app.get('/autenticar', async (req, res) => {
    try {
        const token = await autenticarBling();
        res.json({ 
            success: true, 
            message: 'Autenticação realizada com sucesso!',
            hasToken: !!token
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            erro: error.message 
        });
    }
});

// Endpoint para sincronizar estoque
app.get('/enviar-wix', async (req, res) => {
    try {
        console.log('🚀 Iniciando sincronização...');
        
        const produtos = await buscarProdutosBling();
        
        if (produtos.length === 0) {
            return res.json({ 
                success: true, 
                message: 'Nenhum produto com estoque encontrado',
                produtos: 0 
            });
        }

        const resultado = await enviarParaWix(produtos);
        
        res.json({ 
            success: true, 
            message: 'Sincronização realizada com sucesso!',
            produtos: produtos.length,
            resultado 
        });
    } catch (error) {
        console.error('❌ Erro na sincronização:', error.message);
        res.status(500).json({ 
            success: false, 
            erro: error.message 
        });
    }
});

// Endpoint para callback do OAuth
app.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    
    if (!code) {
        return res.status(400).send('Código de autorização não encontrado');
    }

    try {
        const response = await axios.post('https://www.bling.com.br/Api/v3/oauth/token', 
            qs.stringify({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET
            }), 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token, refresh_token } = response.data;
        
        res.send(`
            <h1>✅ Autorização bem-sucedida!</h1>
            <p><strong>REFRESH_TOKEN:</strong></p>
            <code style="background: #f0f0f0; padding: 10px; display: block; margin: 10px 0;">${refresh_token}</code>
            <p>⚠️ <strong>IMPORTANTE:</strong> Copie este refresh_token e configure como variável de ambiente REFRESH_TOKEN no Render.</p>
            <p>Após configurar, remova a variável AUTH_CODE (se existir).</p>
        `);
    } catch (error) {
        console.error('Erro no callback:', error.response?.data || error.message);
        res.status(500).send('Erro ao processar autorização');
    }
});

// Inicializar autenticação ao iniciar
autenticarBling().catch(console.error);

app.listen(PORT, () => {
    console.log(`API de sincronização rodando na porta ${PORT}`);
});
