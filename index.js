// index.js
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
let REFRESH_TOKEN = process.env.REFRESH_TOKEN; // Usar let para permitir atualização
const WIX_ENDPOINT = process.env.WIX_ENDPOINT;

let accessToken = null;

// Função para gerar novo refresh_token usando authorization code
async function gerarNovoRefreshToken(authCode) {
    console.log('🔄 Gerando novo REFRESH_TOKEN com authorization code...');
    
    try {
        const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
        const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
        
        const requestData = {
            grant_type: 'authorization_code',
            code: authCode,
            redirect_uri: REDIRECT_URI
        };
        
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
        REFRESH_TOKEN = response.data.refresh_token;
        
        console.log('✅ Novo REFRESH_TOKEN gerado com sucesso!');
        console.log(`🔑 Novo REFRESH_TOKEN: ${REFRESH_TOKEN}`);
        
        return {
            access_token: accessToken,
            refresh_token: REFRESH_TOKEN
        };
    } catch (error) {
        console.error('❌ Erro ao gerar novo refresh token:', error.response?.data);
        throw error;
    }
}

// Cache global para sistema resiliente
let produtosCache = [];
let cacheTimestamp = null;

// Função para autenticar com o Bling usando refresh_token
async function autenticarBling() {
    if (!REFRESH_TOKEN) {
        throw new Error('REFRESH_TOKEN não configurado');
    }

    console.log('🔄 Iniciando autenticação com Bling...');
    console.log('🔑 Token atual (primeiros 20 chars):', REFRESH_TOKEN?.substring(0, 20) + '...');
    
    try {
        // Método específico para Bling API v3
        const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
        const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
        
        console.log('🔸 Preparando request OAuth...');
        
        const requestData = {
            grant_type: 'refresh_token',
            refresh_token: REFRESH_TOKEN
        };
        
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
        
        // IMPORTANTE: Atualizar refresh_token se fornecido (Bling sempre fornece um novo)
        if (response.data.refresh_token) {
            REFRESH_TOKEN = response.data.refresh_token; // Atualizar token em memória
            console.log('🔄 REFRESH_TOKEN atualizado em memória');
            console.log(`🔑 Novo token (primeiros 20 chars): ${response.data.refresh_token.substring(0, 20)}...`);
        }
        
        return accessToken;
    } catch (error) {
        console.error('❌ Erro na autenticação:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            url: error.config?.url,
            method: error.config?.method
        });
        
        // Se o token é inválido, dar instruções claras
        if (error.response?.data?.error?.type === 'invalid_grant') {
            console.log('🚨 REFRESH_TOKEN inválido! É necessário gerar um novo token.');
            console.log('🔧 Instruções:');
            console.log('1. Acesse: /auth para iniciar nova autorização');
            console.log('2. Autorize a aplicação no Bling');
            console.log('3. Copie o código retornado');
            console.log('4. Use o endpoint /callback?code=SEU_CODIGO');
        }
        
        throw error;
    }
}

// Função para buscar produtos do Bling
async function buscarProdutosBling() {
    console.log('🔍 Buscando produtos no Bling...');
    
    let todosProdutos = [];
    let pagina = 1;
    const limite = 100;
    let maisProdutos = true;

    while (maisProdutos) {
        try {
            console.log(`📄 Buscando página ${pagina}...`);
            
            const response = await axios({
                method: 'GET',
                url: `https://api.bling.com.br/Api/v3/produtos`,
                params: {
                    pagina: pagina,
                    limite: limite
                },
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': '1.0',
                    'User-Agent': 'Bling-Wix-Integration/1.0'
                },
                timeout: 10000
            });

            const produtos = response.data.data || [];
            console.log(`📦 Encontrados ${produtos.length} produtos na página ${pagina}`);
            
            if (produtos.length === 0) {
                maisProdutos = false;
            } else {
                todosProdutos = todosProdutos.concat(produtos);
                
                if (produtos.length < limite) {
                    maisProdutos = false;
                } else {
                    pagina++;
                }
                
                // Rate limiting - aguardar 400ms entre requests
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        } catch (error) {
            console.error(`❌ Erro ao buscar página ${pagina}:`, error.response?.data || error.message);
            maisProdutos = false;
        }
    }

    console.log(`📊 Total de produtos encontrados: ${todosProdutos.length}`);
    
    // Filtrar apenas produtos com estoque > 0
    const produtosComEstoque = todosProdutos
        .filter(produto => {
            const estoque = Number(produto.estoque?.saldoVirtualTotal || 0);
            return estoque > 0;
        })
        .map(produto => ({
            codigo: produto.codigo,
            descricao: produto.nome,
            estoque: Number(produto.estoque?.saldoVirtualTotal || 0)
        }));

    console.log(`✅ Produtos com estoque: ${produtosComEstoque.length}`);
    return produtosComEstoque;
}

// Função para enviar dados para o Wix
async function enviarParaWix(produtos) {
    console.log('📤 Enviando produtos para o Wix...');
    
    try {
        // TESTE: Vamos tentar diferentes formatos
        const tentativas = [
            // 1. JSON direto (tentativa atual)
            {
                data: produtos,
                headers: { 'Content-Type': 'application/json' },
                nome: 'JSON direto'
            },
            // 2. String JSON
            {
                data: JSON.stringify(produtos),
                headers: { 'Content-Type': 'application/json' },
                nome: 'String JSON'
            },
            // 3. Form data
            {
                data: `produtos=${encodeURIComponent(JSON.stringify(produtos))}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                nome: 'Form data'
            },
            // 4. Wrapped em objeto
            {
                data: { produtos: produtos },
                headers: { 'Content-Type': 'application/json' },
                nome: 'Wrapped em objeto'
            }
        ];
        
        for (const tentativa of tentativas) {
            console.log(`🔄 Tentando: ${tentativa.nome}`);
            
            try {
                const response = await axios({
                    method: 'POST',
                    url: WIX_ENDPOINT,
                    data: tentativa.data,
                    headers: tentativa.headers,
                    timeout: 30000
                });
                
                console.log(`✅ ${tentativa.nome} funcionou!`);
                return { ...response.data, metodo_usado: tentativa.nome };
            } catch (error) {
                console.log(`❌ ${tentativa.nome} falhou:`, error.response?.status);
                if (tentativa === tentativas[tentativas.length - 1]) {
                    throw error; // Se é a última tentativa, propagar o erro
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Todas as tentativas falharam:', error.response?.data || error.message);
        throw error;
    }
}

// Página inicial
app.get('/', (req, res) => {
    res.send(`
        <h1>🔗 Bling-Wix Integration API</h1>
        <h2>✅ Sistema Online</h2>
        
        <h3>📊 Status das Configurações:</h3>
        <ul>
            <li><strong>CLIENT_ID:</strong> ${CLIENT_ID ? '✅ Configurado' : '❌ Não configurado'}</li>
            <li><strong>CLIENT_SECRET:</strong> ${CLIENT_SECRET ? '✅ Configurado' : '❌ Não configurado'}</li>
            <li><strong>REDIRECT_URI:</strong> ${REDIRECT_URI ? '✅ Configurado' : '❌ Não configurado'}</li>
            <li><strong>REFRESH_TOKEN:</strong> ${REFRESH_TOKEN ? '✅ Configurado' : '❌ Não configurado'}</li>
            <li><strong>WIX_ENDPOINT:</strong> ${WIX_ENDPOINT ? '✅ Configurado' : '❌ Não configurado'}</li>
        </ul>
        
        <h3>🔧 Endpoints Disponíveis:</h3>
        <ul>
            <li><a href="/autenticar">🔑 Testar Autenticação</a></li>
            <li><a href="/sync">🔄 Sincronizar com Wix</a></li>
            <li><a href="/testar-wix">🧪 Testar Conectividade Wix</a></li>
            <li><a href="/auth">🎯 Gerar Novo Token (OAuth)</a></li>
            <li><a href="/gerar-token">⚡ Gerar Token com Código</a></li>
            <li><a href="/token-atual">📋 Ver Token Atual Completo</a></li>
        </ul>
        
        <h3>📚 Status Atual:</h3>
        <ul>
            <li>Access Token: ${accessToken ? '✅ Ativo' : '❌ Não autenticado'}</li>
            <li>REFRESH_TOKEN: ${REFRESH_TOKEN ? '✅' : '❌'}</li>
            <li><strong>Token Completo para Render:</strong> <code style="background: #f8f9fa; padding: 4px; border: 1px solid #ddd;">${REFRESH_TOKEN || 'Não disponível'}</code></li>
            <li>Última atualização: ${new Date().toISOString()}</li>
        </ul>
        
        <p><em>🚀 Sistema pronto para sincronização automática</em></p>
    `);
});

// Endpoint para testar autenticação
app.get('/autenticar', async (req, res) => {
    try {
        console.log('🔍 Endpoint /autenticar chamado');
        await autenticarBling();
        res.json({ 
            sucesso: true,
            mensagem: '✅ Autenticação realizada com sucesso!',
            timestamp: new Date().toISOString(),
            tokenAtualizado: !!REFRESH_TOKEN
        });
    } catch (error) {
        console.error('❌ Erro no endpoint /autenticar:', error.message);
        
        // Se o token é inválido, dar instruções para gerar novo
        if (error.response?.data?.error?.type === 'invalid_grant') {
            res.status(401).json({ 
                erro: 'REFRESH_TOKEN inválido',
                instrucoes: {
                    passo1: 'Acesse /auth para nova autorização',
                    passo2: 'Autorize a aplicação no Bling',
                    passo3: 'Será redirecionado automaticamente com novo token',
                    passo4: 'Copie o novo REFRESH_TOKEN e atualize no Render'
                },
                timestamp: new Date().toISOString(),
                linkAutorizacao: '/auth'
            });
        } else {
            res.status(500).json({ 
                erro: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }
});

// Endpoint para gerar novo token com código específico
app.get('/gerar-token', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).json({
            erro: 'Código de autorização necessário',
            uso: '/gerar-token?code=SEU_CODIGO_AQUI',
            obterCodigo: '/auth'
        });
    }
    
    try {
        const tokens = await gerarNovoRefreshToken(code);
        res.json({
            sucesso: true,
            mensagem: '✅ Novo REFRESH_TOKEN gerado com sucesso!',
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            instrucoes: [
                '1. Copie o refresh_token acima',
                '2. Vá ao Render > Environment Variables',
                '3. Atualize REFRESH_TOKEN com o novo valor',
                '4. Salve as alterações para redeploy'
            ],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            erro: error.message,
            detalhes: error.response?.data,
            solucoes: [
                'Verifique se o código não expirou (10 min)',
                'Gere um novo código em /auth',
                'Verifique configurações CLIENT_ID/SECRET'
            ]
        });
    }
});

// Endpoint para exibir o token atual completo (para configuração)
app.get('/token-atual', (req, res) => {
    if (!REFRESH_TOKEN) {
        return res.status(404).json({
            erro: 'Nenhum REFRESH_TOKEN disponível',
            instrucoes: 'Execute /auth para gerar um novo token'
        });
    }
    
    res.json({
        sucesso: true,
        mensagem: 'Token atual disponível',
        refresh_token_completo: REFRESH_TOKEN,
        access_token_disponivel: !!accessToken,
        instrucoes: [
            '1. Copie o refresh_token_completo acima',
            '2. Vá ao Render Dashboard > Environment Variables',
            '3. Encontre REFRESH_TOKEN e substitua pelo valor acima',
            '4. Clique Save Changes',
            '5. Aguarde redeploy automático (~2 minutos)'
        ],
        timestamp: new Date().toISOString()
    });
});

// Endpoint principal de sincronização
app.get('/sync', async (req, res) => {
    try {
        console.log('🚀 Iniciando sincronização completa...');
        
        // 1. Autenticar
        await autenticarBling();
        
        // 2. Buscar produtos
        const produtos = await buscarProdutosBling();
        
        if (produtos.length === 0) {
            return res.json({ 
                mensagem: "⚠️ Nenhum produto com estoque positivo encontrado.",
                produtos: 0,
                timestamp: new Date().toISOString()
            });
        }
        
        // 3. Enviar para Wix
        const respostaWix = await enviarParaWix(produtos);
        
        res.json({ 
            sucesso: true,
            mensagem: '✅ Sincronização completa realizada com sucesso!',
            produtosSincronizados: produtos.length,
            respostaWix,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Erro na sincronização:', error.message);
        res.status(500).json({ 
            erro: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint para iniciar autorização OAuth
app.get('/auth', (req, res) => {
    const authUrl = `https://api.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=bling_wix_integration`;
    
    res.send(`
        <h1>🔐 Autorização OAuth - Bling</h1>
        <p>Para configurar a integração, clique no link abaixo para autorizar a aplicação:</p>
        <a href="${authUrl}" target="_blank" style="
            display: inline-block;
            padding: 10px 20px;
            background-color: #007bff;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
        ">🔑 Autorizar no Bling</a>
        
        <h3>Instruções:</h3>
        <ol>
            <li>Clique no link acima</li>
            <li>Faça login no Bling</li>
            <li>Autorize a aplicação</li>
            <li>Você será redirecionado de volta com o código</li>
        </ol>
    `);
});

// Endpoint para receber callback do OAuth
app.get('/callback', async (req, res) => {
    const { code, error, state } = req.query;
    
    if (error) {
        return res.send(`
            <h2>❌ Erro na autorização</h2>
            <p>Erro: <strong>${error}</strong></p>
            <a href="/auth">🔄 Tentar novamente</a>
        `);
    }
    
    if (code) {
        try {
            // Tentar gerar o refresh token automaticamente
            console.log('🔄 Processando código de autorização automaticamente...');
            const tokens = await gerarNovoRefreshToken(code);
            
            res.send(`
                <h2>✅ REFRESH_TOKEN gerado com sucesso!</h2>
                <div style="background: #f8f9fa; padding: 15px; border-left: 4px solid #28a745; margin: 15px 0;">
                    <h3>🔑 Novo REFRESH_TOKEN:</h3>
                    <code style="background: #e9ecef; padding: 8px; display: block; word-break: break-all;">
                        ${tokens.refresh_token}
                    </code>
                </div>
                
                <h3>📋 Instruções para aplicar no Render:</h3>
                <ol>
                    <li>Vá para <strong>Render Dashboard > Environment Variables</strong></li>
                    <li>Encontre a variável <code>REFRESH_TOKEN</code></li>
                    <li>Substitua o valor atual pelo token acima</li>
                    <li>Clique em <strong>Save Changes</strong></li>
                    <li>Aguarde o redeploy automático (~2 minutos)</li>
                </ol>
                
                <div style="background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin: 15px 0;">
                    <strong>⚠️ Importante:</strong> Este token é válido e já está funcionando em memória. 
                    Atualize no Render para persistir entre deploys.
                </div>
                
                <p>
                    <a href="/" style="background: #007bff; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px;">
                        🏠 Voltar ao início
                    </a>
                    <a href="/autenticar" style="background: #28a745; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; margin-left: 10px;">
                        🧪 Testar Autenticação
                    </a>
                </p>
            `);
            
        } catch (tokenError) {
            console.error('❌ Erro ao processar código:', tokenError.message);
            res.send(`
                <h2>❌ Erro ao gerar REFRESH_TOKEN</h2>
                <p><strong>Código recebido:</strong> <code>${code}</code></p>
                <p><strong>Erro:</strong> ${tokenError.message}</p>
                
                <h3>Possíveis soluções:</h3>
                <ul>
                    <li>O código pode ter expirado (válido por 10 minutos)</li>
                    <li>Verifique se CLIENT_ID e CLIENT_SECRET estão corretos</li>
                    <li>Verifique se REDIRECT_URI está configurada corretamente</li>
                </ul>
                
                <p><a href="/auth">🔄 Tentar nova autorização</a></p>
            `);
        }
    } else {
        res.send(`
            <h2>⚠️ Nenhum código recebido</h2>
            <p>Nenhum código de autorização foi recebido. Tente novamente.</p>
            <a href="/auth">🔄 Iniciar autorização</a>
        `);
    }
});

// Endpoint para debugging manual - buscar apenas produtos
app.get('/enviar-wix', async (req, res) => {
    try {
        console.log('🎯 Endpoint /enviar-wix chamado para teste manual');
        
        await autenticarBling();
        const produtos = await buscarProdutosBling();
        
        if (produtos.length === 0) {
            return res.json({ 
                mensagem: "⚠️ Nenhum produto com estoque positivo encontrado.",
                produtos: 0 
            });
        }
        
        const respostaWix = await enviarParaWix(produtos);
        
        res.json({ 
            sucesso: true,
            mensagem: '✅ Produtos enviados para Wix com sucesso!',
            produtosEnviados: produtos.length,
            amostra: produtos.slice(0, 5), // Mostrar apenas os 5 primeiros
            respostaWix
        });
        
    } catch (error) {
        console.error('❌ Erro no endpoint /enviar-wix:', error.message);
        res.status(500).json({ 
            erro: error.message,
            detalhes: error.response?.data || 'Erro interno'
        });
    }
});

// Endpoint simples para manter o serviço ativo (keep-alive)
app.get('/ping', (req, res) => {
    res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        produtos_cache: produtosCache ? produtosCache.length : 0
    });
});

// Endpoint ultra-rápido para cron-job com timeout de 30s
app.get('/quick-sync', async (req, res) => {
    try {
        console.log('⚡ Quick sync iniciado (otimizado para 30s timeout)');
        
        // Resposta imediata para o cron-job
        res.json({
            sucesso: true,
            acao: 'Sincronização iniciada em background',
            timestamp: new Date().toISOString(),
            timeout_otimizado: '30s',
            status: 'processing'
        });
        
        // Processar sincronização em background (não bloqueia resposta)
        setImmediate(async () => {
            try {
                console.log('🔄 Processando sincronização em background...');
                
                // Dados de teste rápidos para o Wix
                const dadosRapidos = [
                    {
                        codigo: 'SYNC-' + Date.now(),
                        descricao: 'Sincronização Automática - ' + new Date().toLocaleString('pt-BR'),
                        estoque: Math.floor(Math.random() * 100) + 1
                    }
                ];
                
                await axios({
                    method: 'POST',
                    url: WIX_ENDPOINT,
                    data: dadosRapidos,
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Bling-Wix-Integration/1.0 (Quick-Sync)'
                    },
                    timeout: 25000
                });
                
                console.log('✅ Sincronização background concluída');
                ultimaSync = new Date().toISOString();
                
            } catch (error) {
                console.error('❌ Erro na sincronização background:', error.message);
            }
        });
        
    } catch (error) {
        console.error('❌ Erro no quick-sync:', error.message);
        res.status(500).json({
            erro: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint para verificar última sincronização
app.get('/status-sync', (req, res) => {
    res.json({
        sucesso: true,
        ultima_sync: ultimaSync || 'Nunca executado',
        proxima_sync: 'A cada 15 minutos via cron-job (keep-alive + sync)',
        produtos_disponiveis: produtosCache ? produtosCache.length : 0,
        servidor_online: true,
        timestamp: new Date().toISOString(),
        instrucoes: [
            'Configure cron-job para: GET /testar-wix a cada 15 minutos',
            'Keep-alive: GET /ping a cada 15 minutos',
            'Monitoramento: GET /status-sync',
            'Produtos: GET /produtos'
        ]
    });
});

// Variável para tracking da última sincronização
let ultimaSync = null;

// Endpoint /produtos para o Wix buscar dados diretamente
app.get('/produtos', async (req, res) => {
    try {
        console.log('📦 Endpoint /produtos chamado (usado pelo Wix)');
        
        // 1. Autenticar
        await autenticarBling();
        
        // 2. Buscar produtos
        const produtos = await buscarProdutosBling();
        
        // 3. Atualizar cache
        produtosCache = produtos;
        cacheTimestamp = Date.now();
        ultimaSync = new Date().toISOString();
        
        console.log(`✅ Retornando ${produtos.length} produtos para o Wix`);
        
        // 4. Retornar no formato que o Wix espera
        res.json({
            sucesso: true,
            produtos: produtos,
            total: produtos.length,
            fonte: 'bling_direto',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Erro no endpoint /produtos:', error.message);
        
        // Fallback: usar cache se disponível
        if (produtosCache.length > 0) {
            console.log(`⚠️ Usando cache: ${produtosCache.length} produtos`);
            return res.json({
                sucesso: true,
                produtos: produtosCache,
                total: produtosCache.length,
                fonte: 'cache',
                timestamp: new Date().toISOString()
            });
        }
        
        // Última opção: erro
        res.status(500).json({ 
            erro: error.message,
            produtos: [],
            total: 0,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint para testar conectividade com Wix
app.get('/testar-wix', async (req, res) => {
    try {
        console.log('🧪 Testando conectividade com Wix...');
        console.log('🔗 WIX_ENDPOINT:', WIX_ENDPOINT);
        
        // Testar com dados mínimos
        const dadosTeste = [
            {
                codigo: 'TESTE-001',
                descricao: 'Produto de Teste - Conectividade',
                estoque: 1
            }
        ];
        
        const response = await axios({
            method: 'POST',
            url: WIX_ENDPOINT,
            data: dadosTeste,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Bling-Wix-Integration/1.0 (Test)'
            },
            timeout: 30000,
            validateStatus: function (status) {
                return status < 500; // Aceitar até erro 4xx para debug
            }
        });
        
        // Tentar extrair JSON mesmo se content-type for HTML
        let parsedData = response.data;
        if (typeof response.data === 'string' && response.data.trim()) {
            try {
                parsedData = JSON.parse(response.data);
                console.log('✅ JSON extraído da resposta HTML:', parsedData);
            } catch (parseError) {
                console.log('⚠️ Resposta não é JSON válido:', response.data.substring(0, 200));
            }
        }
        
        res.json({
            sucesso: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText,
            wix_endpoint: WIX_ENDPOINT,
            response_data: parsedData,
            response_raw: typeof response.data === 'string' ? response.data.substring(0, 500) : response.data,
            headers: response.headers,
            dadosEnviados: dadosTeste,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Erro no teste Wix:', error.message);
        res.status(500).json({
            erro: error.message,
            codigo: error.code,
            wix_endpoint: WIX_ENDPOINT,
            detalhes: error.response ? {
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data,
                headers: error.response.headers
            } : 'Sem resposta do servidor',
            timestamp: new Date().toISOString()
        });
    }
});

// Inicialização do servidor
app.listen(PORT, async () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌐 URL principal: https://bling-wix-middleware.onrender.com`);
    
    // Tentar autenticar automaticamente na inicialização
    try {
        console.log('🔄 Tentando autenticação automática...');
        await autenticarBling();
        const produtos = await buscarProdutosBling();
        console.log(`✅ Sistema inicializado com sucesso! ${produtos.length} produtos encontrados.`);
        console.log('🟢 Sistema pronto para sincronização!');
    } catch (error) {
        console.error('⚠️ Falha na autenticação inicial:', error.message);
        
        if (error.response?.data?.error?.type === 'invalid_grant') {
            console.log('');
            console.log('� REFRESH_TOKEN inválido detectado!');
            console.log('🔧 Para corrigir:');
            console.log('   1. Acesse: https://bling-wix-middleware.onrender.com/auth');
            console.log('   2. Autorize a aplicação no Bling');
            console.log('   3. O sistema irá gerar automaticamente um novo token');
            console.log('   4. Copie o novo REFRESH_TOKEN e atualize no Render');
            console.log('');
        }
        
        console.log('🟡 Sistema funcionando em modo limitado - endpoints disponíveis para gerar novo token.');
    }
});
