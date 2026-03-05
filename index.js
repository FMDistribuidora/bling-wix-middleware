// index.js - CORRIGIDO v4.1 (tratamento invalid_grant, Cloudflare 1015, backoff, cache configurável)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// CORS liberado para qualquer origem
app.use(cors({
  origin: '*',
}));

app.use(express.json());

// Configurações do Bling
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
let REFRESH_TOKEN = process.env.REFRESH_TOKEN;

let accessToken = null;

// Cache otimizado com TTL (configurável via env CACHE_TTL_MS)
const DEFAULT_CACHE_TTL_MS = process.env.CACHE_TTL_MS ? Number(process.env.CACHE_TTL_MS) : (30 * 60 * 1000); // 30 minutos
const CACHE_TTL = DEFAULT_CACHE_TTL_MS;

let produtosCache = [];
let cacheTimestamp = null;

// Controla se deve pré-carregar o cache na inicialização (evitar tráfego automático)
const PRELOAD_CACHE = (process.env.PRELOAD_CACHE === 'true'); // default: false

/* ---------------------------
   Validação simples de ENV
   --------------------------- */
function validarEnv() {
  const required = ['CLIENT_ID','CLIENT_SECRET','REDIRECT_URI'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Variáveis de ambiente faltando:', missing.join(', '));
  } else {
    console.log('✅ Variáveis de ambiente essenciais presentes.');
  }
}
validarEnv();

/* ---------------------------
   Helpers
   --------------------------- */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractRayIdFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  // tenta vários padrões possíveis
  const m1 = html.match(/Ray ID:?\s*([0-9a-f\-]{8,})/i);
  if (m1) return m1[1];
  const m2 = html.match(/ID do Raio[\s\S]*?:\s*([0-9a-f]{8,})/i);
  if (m2) return m2[1];
  const m3 = html.match(/Ray:\s*([0-9a-f]{8,})/i);
  if (m3) return m3[1];
  return null;
}

function isHtmlResponse(resp) {
  if (!resp) return false;
  const ct = resp.headers && resp.headers['content-type'];
  if (ct && ct.includes('text/html')) return true;
  if (typeof resp.data === 'string' && resp.data.trim().startsWith('<')) return true;
  return false;
}

/* ---------------------------
   Função para autenticar com o Bling usando refresh_token
   --------------------------- */
async function autenticarBling() {
    if (!REFRESH_TOKEN) {
        throw new Error('REFRESH_TOKEN não configurado');
    }

    console.log('🔄 Autenticando com Bling (refresh_token)...');
    
    try {
        const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
        const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
        
        const requestData = {
            grant_type: 'refresh_token',
            refresh_token: REFRESH_TOKEN
        };

        // DEBUG: log mínimo do payload (evite logar valores sensíveis em produção)
        console.log('➡️ POST https://api.bling.com.br/Api/v3/oauth/token', { grant_type: requestData.grant_type });

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
            timeout: 15000,
            validateStatus: status => true // vamos lidar com status manualmente
        });

        // Se resposta for HTML (Cloudflare) detecta bloqueio
        if (isHtmlResponse(response)) {
            const ray = extractRayIdFromHtml(response.data);
            console.error('❌ Possível bloqueio Cloudflare na autenticação. Ray ID:', ray || 'N/A');
            console.error('❌ Corpo (HTML) recebido do Bling (truncado):', response.data.substring(0, 800));
            const err = new Error('Bloqueio Cloudflare detectado (Error 1015 ou similar).');
            err.code = 'CLOUDFLARE_BLOCK';
            err.rayId = ray;
            throw err;
        }

        if (response.status !== 200) {
            // tenta interpretar JSON de erro
            const body = response.data;
            if (body && body.error && (body.error.tipo === 'invalid_grant' || body.error === 'invalid_grant')) {
                console.error('❌ Token de atualização inválido — gere um novo via /auth e atualize REFRESH_TOKEN no Render.');
                const err = new Error('invalid_grant');
                err.code = 'INVALID_GRANT';
                throw err;
            }
            console.error('❌ Erro na autenticação. status:', response.status);
            console.error('❌ Corpo da resposta do Bling:', typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body).substring(0,800));
            const err = new Error(`Autenticação falhou com status ${response.status}`);
            err.code = 'AUTH_FAILED';
            throw err;
        }

        accessToken = response.data.access_token;
        console.log('✅ Autenticação bem-sucedida! token obtido.');

        if (response.data.refresh_token) {
            console.log('ℹ️ Novo refresh_token recebido (será usado em memória).');
            REFRESH_TOKEN = response.data.refresh_token;
        }
        
        return accessToken;
    } catch (error) {
        if (error.code === 'INVALID_GRANT') {
            // rethrow para o caller saber que precisa de intervenção manual
            throw error;
        }
        if (error.code === 'CLOUDFLARE_BLOCK') {
            throw error;
        }
        // outros erros (network, timeout)
        console.error('❌ Erro na autenticação (ex):', error.message);
        throw error;
    }
}

/* ---------------------------
   FUNÇÃO CORRIGIDA - BUSCA TODOS OS PRODUTOS
   --------------------------- */
async function buscarProdutosBling() {
    console.log('🔍 Buscando TODOS os produtos no Bling...');
    
    let todosProdutos = [];
    let pagina = 1;
    const limite = 100;
    let maisProdutos = true;
    let tentativasErro = 0;
    const MAX_TENTATIVAS = 3;
    const MAX_PAGINA_TENTATIVAS = 2;
    
    while (maisProdutos && tentativasErro < MAX_TENTATIVAS) {
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
                timeout: 12000,
                validateStatus: status => true
            });

            // Detecta bloqueio Cloudflare / HTML
            if (isHtmlResponse(response)) {
                const ray = extractRayIdFromHtml(response.data);
                console.error('❌ Bloqueio Cloudflare detectado ao buscar produtos. Ray ID:', ray || 'N/A');
                console.error('❌ Corpo (HTML) recebido do Bling (truncado):', response.data.substring(0,800));
                // faz backoff longo e aborta esta execução para evitar agravamento
                const err = new Error('Bloqueio Cloudflare detectado (Error 1015).');
                err.code = 'CLOUDFLARE_BLOCK';
                err.rayId = ray;
                throw err;
            }

            // Status handling
            if (response.status === 401) {
                console.error('❌ 401 ao buscar produtos — access token inválido/expirado. Forçando reautenticação.');
                // Tentar reautenticar uma vez
                await autenticarBling();
                continue; // re-tenta a mesma página
            }

            if (response.status === 429) {
                console.error('❌ 429 Rate limited pelo Bling. Aplicando backoff exponencial.');
                throw Object.assign(new Error('Rate limited'), { code: 'RATE_LIMIT' });
            }

            if (response.status >= 400) {
                console.error(`❌ Erro HTTP ${response.status} na busca de produtos.`);
                console.error('❌ Corpo retornado:', typeof response.data === 'object' ? JSON.stringify(response.data).substring(0,800) : String(response.data).substring(0,800));
                throw new Error(`HTTP ${response.status}`);
            }

            const produtos = (response.data && response.data.data) ? response.data.data : [];
            console.log(`📦 Página ${pagina}: ${produtos.length} produtos`);
            
            if (produtos.length === 0 || produtos.length < limite) {
                maisProdutos = false;
                console.log(`✅ Última página alcançada (página ${pagina})`);
            } else {
                pagina++;
            }
            
            todosProdutos = todosProdutos.concat(produtos);
            tentativasErro = 0;
            // delay entre páginas para reduzir chance de rate-limit
            await sleep(500);
            
        } catch (error) {
            console.error(`❌ Erro na página ${pagina}:`, error.message);
            tentativasErro++;

            // Trate invalid_grant (propaga para fora para intervenção manual)
            if (error.code === 'INVALID_GRANT') {
                console.error('❌ invalid_grant: refresh token inválido. Gere um novo token via /auth e atualize REFRESH_TOKEN no Render.');
                throw error;
            }

            if (error.code === 'CLOUDFLARE_BLOCK') {
                // backoff longo e abortar
                console.error('❌ Abortando busca devido a bloqueio Cloudflare. Aguarde liberação/desbloqueio com o suporte do Bling.');
                throw error;
            }

            // rate limit -> backoff exponencial
            if (error.code === 'RATE_LIMIT' || (error.response && error.response.status === 429)) {
                const backoffMs = Math.min(60 * 1000, 1000 * Math.pow(2, tentativasErro)); // cap em 60s
                console.warn(`⚠️ Rate limited. Esperando ${backoffMs}ms antes de tentar novamente... (tentativa ${tentativasErro}/${MAX_TENTATIVAS})`);
                await sleep(backoffMs);
            } else {
                // erro genérico: espera curta antes de tentar
                await sleep(2000);
            }
            
            if (tentativasErro >= MAX_TENTATIVAS) {
                console.log(`🛑 Parando após ${MAX_TENTATIVAS} tentativas consecutivas`);
                break;
            }
        }
    }

    console.log(`📊 Total de produtos encontrados: ${todosProdutos.length}`);
    
    const todosProdutosFormatados = todosProdutos.map(produto => {
        let estoque = Number(produto.estoque?.saldoVirtualTotal || 0);
        if (estoque < 0) estoque = 0;
        return {
            codigo: produto.codigo,
            descricao: produto.nome,
            estoque: estoque
        };
    });

    const produtosComEstoque = todosProdutosFormatados.filter(p => p.estoque > 0).length;
    const produtosSemEstoque = todosProdutosFormatados.filter(p => p.estoque === 0).length;
    
    console.log(`✅ Total produtos processados: ${todosProdutosFormatados.length}`);
    console.log(`📈 Com estoque: ${produtosComEstoque}`);
    console.log(`📉 Sem estoque: ${produtosSemEstoque}`);
    
    return todosProdutosFormatados;
}

// Verificar se cache é válido
function cacheValido() {
    return cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL;
}

// Página inicial
app.get('/', (req, res) => {
    res.send(`
        <h1>🔗 Bling-Wix Integration API</h1>
        <h2>✅ Sistema Online - VERSÃO CORRIGIDA v4.1</h2>
        
        <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; margin: 15px 0; border-radius: 5px;">
            <h3>🚀 CORREÇÕES APLICADAS:</h3>
            <ul>
                <li>✅ <strong>Busca TODOS os produtos</strong> - Sem limite de páginas</li>
                <li>✅ <strong>Inclui produtos sem estoque</strong> - Não filtra mais</li>
                <li>✅ <strong>Converte negativos para zero</strong> - Tratamento de dados</li>
                <li>✅ <strong>Cache inteligente (config via CACHE_TTL_MS)</strong> - Performance mantida</li>
                <li>✅ <strong>Detecção invalid_grant e Cloudflare 1015</strong></li>
                <li>✅ <strong>Backoff para 429 / bloqueios</strong></li>
            </ul>
        </div>
        
        <h3>📊 Status:</h3>
        <ul>
            <li><strong>Cache:</strong> ${cacheValido() ? `✅ ${produtosCache.length} produtos (válido)` : '❌ Inválido'}</li>
            <li><strong>Access Token:</strong> ${accessToken ? '✅ Ativo' : '❌ Não autenticado'}</li>
            <li><strong>Versão:</strong> CORRIGIDA v4.1</li>
            <li><strong>PRELOAD_CACHE:</strong> ${PRELOAD_CACHE}</li>
            <li><strong>CACHE_TTL_MS:</strong> ${CACHE_TTL}</li>
        </ul>
        
        <h3>🔧 Endpoints:</h3>
        <ul>
            <li><a href="/produtos" style="background: #007bff; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px;">📦 Produtos (TODOS)</a></li>
            <li><a href="/autenticar">🔑 Testar Autenticação</a></li>
            <li><a href="/auth">🎯 Gerar Novo Token</a></li>
        </ul>
    `);
});

// Endpoint para autenticação
app.get('/autenticar', async (req, res) => {
    try {
        await autenticarBling();
        res.json({ 
            sucesso: true,
            mensagem: '✅ Autenticação realizada com sucesso!',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        const body = {
            erro: error.message,
            code: error.code || null,
            rayId: error.rayId || null,
            timestamp: new Date().toISOString()
        };
        // se invalid_grant, informar status 400 para facilitar debugging
        const status = error.code === 'INVALID_GRANT' ? 400 : 500;
        res.status(status).json(body);
    }
});

// Endpoint para iniciar autorização OAuth
app.get('/auth', (req, res) => {
    const authUrl = `https://api.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=bling_wix_integration`;
    
    res.send(`
        <h1>🔐 Autorização OAuth - Bling</h1>
        <a href="${authUrl}" target="_blank" style="
            display: inline-block;
            padding: 10px 20px;
            background-color: #007bff;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
        ">🔑 Autorizar no Bling</a>
    `);
});

// Endpoint para receber callback do OAuth
app.get('/callback', async (req, res) => {
    const { code, error } = req.query;
    
    if (error) {
        return res.send(`<h2>❌ Erro: ${error}</h2>`);
    }
    
    if (code) {
        try {
            const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
            const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
            
            const requestData = {
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI
            };
            
            const response = await axios({
                method: 'POST',
                url: 'https://api.bling.com.br/Api/v3/oauth/token',
                data: qs.stringify(requestData),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${base64Auth}`,
                    'Accept': '1.0'
                },
                timeout: 10000,
                validateStatus: status => true
            });

            if (isHtmlResponse(response)) {
                const ray = extractRayIdFromHtml(response.data);
                console.error('❌ Cloudflare block on token exchange. Ray ID:', ray);
                return res.send(`<h2>❌ Cloudflare block detected. Ray ID: ${ray || 'N/A'}</h2>`);
            }

            if (response.status !== 200) {
                console.error('❌ Erro ao gerar token (callback). status:', response.status);
                console.error('❌ Corpo da resposta do Bling (callback):', typeof response.data === 'object' ? JSON.stringify(response.data, null, 2) : String(response.data).substring(0,800));
                return res.send(`<h2>❌ Erro ao gerar token: status ${response.status}</h2>`);
            }

            accessToken = response.data.access_token;
            REFRESH_TOKEN = response.data.refresh_token;
            
            res.send(`
                <h2>✅ REFRESH_TOKEN gerado!</h2>
                <div style="background: #f8f9fa; padding: 15px; margin: 15px 0;">
                    <h3>🔑 Novo REFRESH_TOKEN:</h3>
                    <code style="background: #e9ecef; padding: 8px; display: block; word-break: break-all;">
                        ${REFRESH_TOKEN}
                    </code>
                </div>
                
                <h3>📋 Instruções:</h3>
                <ol>
                    <li>Copie o token acima</li>
                    <li>Vá ao Render → Environment Variables</li>
                    <li>Atualize REFRESH_TOKEN</li>
                    <li>Salve e redeploy</li>
                </ol>
            `);
            
        } catch (tokenError) {
            if (tokenError.response) {
                console.error('❌ Erro ao gerar token (callback). status:', tokenError.response.status);
                console.error('❌ Corpo da resposta do Bling (callback):', JSON.stringify(tokenError.response.data, null, 2));
            } else {
                console.error('❌ Erro ao gerar token (callback):', tokenError.message);
            }
            res.send(`<h2>❌ Erro ao gerar token: ${tokenError.message}</h2>`);
        }
    }
});

// ENDPOINT PRINCIPAL CORRIGIDO
app.get('/produtos', async (req, res) => {
    try {
        console.log('📦 Endpoint /produtos chamado (VERSÃO CORRIGIDA)');
        
        // CORS headers
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, User-Agent');
        
        // Verificar cache primeiro
        if (cacheValido()) {
            console.log(`✅ Usando cache: ${produtosCache.length} produtos`);
            return res.json({
                sucesso: true,
                produtos: produtosCache,
                total: produtosCache.length,
                fonte: 'cache',
                versao: 'CORRIGIDA v4.1',
                timestamp: new Date().toISOString(),
                cache_info: {
                    criado_em: new Date(cacheTimestamp).toISOString(),
                    valido_ate: new Date(cacheTimestamp + CACHE_TTL).toISOString()
                }
            });
        }
        
        console.log('🔄 Cache expirado, buscando TODOS os dados...');
        
        // Autenticar e buscar produtos
        await autenticarBling();
        const produtos = await buscarProdutosBling();
        
        // Atualizar cache
        produtosCache = produtos;
        cacheTimestamp = Date.now();
        
        console.log(`✅ Cache atualizado: ${produtos.length} produtos`);
        
        res.json({
            sucesso: true,
            produtos: produtos,
            total: produtos.length,
            fonte: 'bling_direto',
            versao: 'CORRIGIDA v4.1',
            timestamp: new Date().toISOString(),
            cache_info: {
                atualizado_agora: true,
                valido_ate: new Date(cacheTimestamp + CACHE_TTL).toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Erro no endpoint /produtos:', error.message);
        
        // CORS mesmo em erro
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, User-Agent');
        
        // Se invalid_grant -> 400 com instrução
        if (error.code === 'INVALID_GRANT') {
            return res.status(400).json({
                erro: 'invalid_grant',
                mensagem: 'Refresh token inválido. Gere um novo via /auth e atualize REFRESH_TOKEN no Render.',
                timestamp: new Date().toISOString()
            });
        }

        // Se Cloudflare block -> 502 e Ray ID
        if (error.code === 'CLOUDFLARE_BLOCK') {
            return res.status(502).json({
                erro: 'cloudflare_block',
                mensagem: 'Bloqueio detectado (Cloudflare). Pare o job e contate o Bling com o Ray ID.',
                rayId: error.rayId || null,
                timestamp: new Date().toISOString()
            });
        }

        // Fallback para cache se disponível
        if (produtosCache.length > 0) {
            console.log(`⚠️ Erro na API, usando cache antigo: ${produtosCache.length} produtos`);
            return res.json({
                sucesso: true,
                produtos: produtosCache,
                total: produtosCache.length,
                fonte: 'cache_fallback',
                versao: 'CORRIGIDA v4.1',
                timestamp: new Date().toISOString(),
                aviso: 'Dados do cache devido a erro na API'
            });
        }
        
        // Última opção: erro
        res.status(500).json({ 
            erro: error.message,
            produtos: [],
            total: 0,
            versao: 'CORRIGIDA v4.1',
            timestamp: new Date().toISOString()
        });
    }
});

// Keep alive
app.get('/ping', (req, res) => {
    res.json({
        status: 'alive',
        versao: 'CORRIGIDA v4.1',
        timestamp: new Date().toISOString(),
        cache: {
            produtos: produtosCache.length,
            valido: cacheValido(),
            timestamp: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null
        }
    });
});

// Inicialização corrigida
app.listen(PORT, async () => {
    console.log(`🚀 Servidor CORRIGIDO rodando na porta ${PORT}`);
    console.log(`🌐 URL: https://bling-wix-middleware.onrender.com`);
    console.log(`🎉 VERSÃO: CORRIGIDA v4.1 - Busca TODOS os produtos`);
    
    // Inicialização em background somente se PRELOAD_CACHE=true
    if (PRELOAD_CACHE) {
        setTimeout(async () => {
            try {
                console.log('🔄 Inicializando cache com TODOS os produtos...');
                await autenticarBling();
                const produtos = await buscarProdutosBling();
                produtosCache = produtos;
                cacheTimestamp = Date.now();
                console.log(`✅ Cache inicializado: ${produtos.length} produtos`);
            } catch (error) {
                console.log('⚠️ Falha na inicialização do cache:', error.message);
                console.log('🟡 Sistema funcionará com cache sob demanda');
            }
        }, 2000);
    } else {
        console.log('ℹ️ PRELOAD_CACHE=false → não inicializando cache automaticamente (reduz tráfego de startup).');
    }
});
