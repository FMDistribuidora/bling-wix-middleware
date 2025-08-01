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
    console.log('🔍 CLIENT_ID:', CLIENT_ID?.substring(0, 10) + '...');
    console.log('🔍 REFRESH_TOKEN:', REFRESH_TOKEN?.substring(0, 10) + '...');
    
    try {
        // Método específico para Bling API v3
        const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
        const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
        
        console.log('🔸 Tentando autenticação com Bling API v3...');
        console.log('🔸 Auth String Length:', authString.length);
        console.log('🔸 Base64 Length:', base64Auth.length);
        
        const requestData = {
            grant_type: 'refresh_token',
            refresh_token: REFRESH_TOKEN
        };
        
        console.log('🔸 Request Data:', requestData);
        
        const response = await axios({
            method: 'POST',
            url: 'https://api.bling.com.br/Api/v3/oauth/token',
            data: qs.stringify(requestData),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${base64Auth}`,
                'Accept': '1.0',
                'User-Agent': 'Bling-Wix-Integration/1.0'
            },
            timeout: 10000
        });

        accessToken = response.data.access_token;
        console.log('✅ Autenticação bem-sucedida!');
        
        // Atualizar refresh_token se fornecido
        if (response.data.refresh_token) {
            console.log(`🔑 REFRESH_TOKEN: ${response.data.refresh_token}`);
        }
        
        return accessToken;
    } catch (error) {
        console.error('❌ Erro na autenticação:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
        throw error;
    }
}

// Buscar produtos com estoque do Bling
async function buscarProdutosBling() {
    if (!accessToken) {
        await autenticarBling();
    }

    try {
        const response = await axios.get('https://api.bling.com.br/Api/v3/produtos', {
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
            <li><a href="/auth">🚀 Gerar Novo Token</a></li>
            <li><a href="/sync">🔄 Sincronizar Estoque</a></li>
        </ul>
        
        <h3>📋 Status dos Endpoints:</h3>
        <ul>
            <li>CLIENT_ID: ${CLIENT_ID ? '✅' : '❌'}</li>
            <li>CLIENT_SECRET: ${CLIENT_SECRET ? '✅' : '❌'}</li>
            <li>REDIRECT_URI: ${REDIRECT_URI ? '✅' : '❌'}</li>
            <li>REFRESH_TOKEN: ${REFRESH_TOKEN ? '✅' : '❌'}</li>
        </ul>
        
        <hr>
        <p><small>v1.0 - FMDistribuidora</small></p>
    `);
});

// Endpoint para iniciar processo de autorização
app.get('/auth', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) {
        return res.status(500).send(`
            <h1>❌ Erro de Configuração</h1>
            <p>CLIENT_ID ou REDIRECT_URI não configurados.</p>
            <a href="/">← Voltar</a>
        `);
    }

    const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=bling_wix_state`;
    
    res.send(`
        <h1>🔐 Gerar Novo REFRESH_TOKEN</h1>
        <p>Clique no botão abaixo para autorizar a aplicação no Bling:</p>
        
        <div style="margin: 20px 0;">
            <a href="${authUrl}" 
               style="background: #007bff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
               🚀 Autorizar Bling
            </a>
        </div>
        
        <p><strong>Instruções:</strong></p>
        <ol>
            <li>Clique no botão acima</li>
            <li>Faça login no Bling</li>
            <li>Autorize a aplicação</li>
            <li>Você será redirecionado de volta com o novo token</li>
        </ol>
        
        <a href="/">← Voltar ao início</a>
    `);
});

// Alias para /enviar-wix
app.get('/sync', async (req, res) => {
    try {
        console.log('🚀 Iniciando sincronização via /sync...');
        
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
        return res.status(400).send(`
            <h1>❌ Erro de Autorização</h1>
            <p>Código de autorização não encontrado.</p>
            <p>Por favor, tente o processo novamente.</p>
            <a href="/auth">🔄 Tentar Novamente</a> | 
            <a href="/">🏠 Início</a>
        `);
    }

    try {
        console.log('🔄 Processando callback com código:', code?.substring(0, 10) + '...');
        
        // Codificar credenciais em Base64 para Basic Auth
        const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        
        const requestData = {
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI
        };
        
        console.log('📤 Enviando requisição para gerar tokens...');
        
        const response = await axios.post('https://api.bling.com.br/Api/v3/oauth/token', 
            qs.stringify(requestData), 
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${credentials}`,
                    'Accept': '1.0',
                    'User-Agent': 'Bling-Wix-Integration/1.0'
                },
                timeout: 10000
            }
        );

        const { access_token, refresh_token, expires_in } = response.data;
        
        console.log('✅ Tokens gerados com sucesso!');
        console.log('🔑 Novo REFRESH_TOKEN:', refresh_token);
        
        res.send(`
            <div style="max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
                <h1 style="color: #28a745;">✅ Autorização Bem-Sucedida!</h1>
                
                <div style="background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
                    <h3>🔑 Seu Novo REFRESH_TOKEN:</h3>
                    <div style="background: #e9ecef; padding: 15px; border-radius: 3px; font-family: monospace; word-break: break-all; border: 1px solid #dee2e6;">
                        ${refresh_token}
                    </div>
                </div>
                
                <div style="background: #fff3cd; padding: 15px; border-radius: 5px; border: 1px solid #ffeaa7; margin: 20px 0;">
                    <h3 style="color: #856404;">⚠️ IMPORTANTE - Próximos Passos:</h3>
                    <ol style="margin: 10px 0;">
                        <li><strong>Copie</strong> o REFRESH_TOKEN acima</li>
                        <li>Vá ao <strong>Render Dashboard</strong></li>
                        <li>Entre no projeto <strong>bling-wix-middleware</strong></li>
                        <li>Clique em <strong>"Environment"</strong></li>
                        <li>Atualize a variável <strong>REFRESH_TOKEN</strong> com o valor acima</li>
                        <li><strong>Salve</strong> as alterações</li>
                        <li>Aguarde o <strong>redeploy automático</strong></li>
                    </ol>
                </div>
                
                <div style="margin: 20px 0;">
                    <h3>🧪 Testar Após Configurar:</h3>
                    <a href="/sync" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 3px; margin-right: 10px;">
                        🔄 Testar Sincronização
                    </a>
                    <a href="/autenticar" style="background: #28a745; color: white; padding: 10px 20px; text-decoration: none; border-radius: 3px;">
                        🔐 Testar Autenticação
                    </a>
                </div>
                
                <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6;">
                    <p><small>
                        <strong>Informações Técnicas:</strong><br>
                        Access Token Expira em: ${expires_in} segundos<br>
                        Estado: ${state}<br>
                        Timestamp: ${new Date().toISOString()}
                    </small></p>
                </div>
                
                <a href="/" style="color: #6c757d;">← Voltar ao Início</a>
            </div>
        `);
    } catch (error) {
        console.error('❌ Erro no callback:', error.response?.data || error.message);
        
        res.status(500).send(`
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
                <h1 style="color: #dc3545;">❌ Erro ao Processar Autorização</h1>
                
                <div style="background: #f8d7da; padding: 15px; border-radius: 5px; border: 1px solid #f5c6cb; margin: 20px 0;">
                    <h3>Detalhes do Erro:</h3>
                    <p><strong>Erro:</strong> ${error.message}</p>
                    ${error.response?.data ? `<p><strong>Resposta da API:</strong> ${JSON.stringify(error.response.data, null, 2)}</p>` : ''}
                </div>
                
                <div style="margin: 20px 0;">
                    <a href="/auth" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 3px; margin-right: 10px;">
                        🔄 Tentar Novamente
                    </a>
                    <a href="/" style="background: #6c757d; color: white; padding: 10px 20px; text-decoration: none; border-radius: 3px;">
                        🏠 Voltar ao Início
                    </a>
                </div>
            </div>
        `);
    }
});

// Inicializar autenticação ao iniciar
autenticarBling().catch(console.error);

app.listen(PORT, () => {
    console.log(`API de sincronização rodando na porta ${PORT}`);
});
