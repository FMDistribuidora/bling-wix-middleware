// index.js - VERSÃO CORRIGIDA PARA BUSCAR TODOS OS PRODUTOS
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
const WIX_ENDPOINT = process.env.WIX_ENDPOINT;

let accessToken = null;

// Cache otimizado com TTL
let produtosCache = [];
let cacheTimestamp = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

// Render API config (para persistir REFRESH_TOKEN)
const RENDER_API_BASE = 'https://api.render.com/v1';
const RENDER_API_KEY = process.env.RENDER_API_KEY;        // configure no Render
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;  // configure no Render (srv-...)

/* ---------------------------
   Validação simples de ENV
   --------------------------- */
function validarEnv() {
  const required = ['CLIENT_ID','CLIENT_SECRET','REDIRECT_URI','WIX_ENDPOINT'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌ Variáveis de ambiente faltando:', missing.join(', '));
  } else {
    console.log('✅ Variáveis de ambiente essenciais presentes.');
  }
}
validarEnv();

/* ---------------------------
   Helpers Render API (env-vars)
   --------------------------- */
async function listRenderEnvVars(serviceId) {
  const url = `${RENDER_API_BASE}/services/${serviceId}/env-vars`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
    timeout: 15000
  });
  return resp.data; // array
}

async function patchRenderEnvVar(serviceId, envId, newValue) {
  const url = `${RENDER_API_BASE}/services/${serviceId}/env-vars/${envId}`;
  const resp = await axios.patch(url, { value: newValue }, {
    headers: { Authorization: `Bearer ${RENDER_API_KEY}` },
    timeout: 15000
  });
  return resp.data;
}

async function postRenderEnvVars(serviceId, varsArray) {
  const url = `${RENDER_API_BASE}/services/${serviceId}/env-vars`;
  const resp = await axios.post(url, varsArray, {
    headers: { Authorization: `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return resp.data;
}

async function updateRenderRefreshToken(newRefreshToken) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.warn('⚠️ RENDER_API_KEY ou RENDER_SERVICE_ID não configurados; pulando atualização automática no Render.');
    return false;
  }

  try {
    console.log('🔃 Atualizando REFRESH_TOKEN no Render (serviceId:', RENDER_SERVICE_ID, ')...');

    const envVars = await listRenderEnvVars(RENDER_SERVICE_ID);
    const existing = Array.isArray(envVars) ? envVars.find(ev => ev.key === 'REFRESH_TOKEN') : null;

    if (existing) {
      try {
        await patchRenderEnvVar(RENDER_SERVICE_ID, existing.id, newRefreshToken);
        console.log('✅ REFRESH_TOKEN atualizado (patch) no Render.');
        return true;
      } catch (patchErr) {
        console.warn('⚠️ Patch falhou, tentando criar via POST. Erro:', patchErr.response ? patchErr.response.data : patchErr.message);
        // fallback continua para POST
      }
    }

    await postRenderEnvVars(RENDER_SERVICE_ID, [{ key: 'REFRESH_TOKEN', value: newRefreshToken }]);
    console.log('✅ REFRESH_TOKEN criado/atualizado (post) no Render.');
    return true;

  } catch (err) {
    console.error('❌ Falha ao atualizar REFRESH_TOKEN no Render:', err.response ? err.response.data : err.message);
    return false;
  }
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
            timeout: 15000
        });

        accessToken = response.data.access_token;
        console.log('✅ Autenticação bem-sucedida! token obtido.');

        if (response.data.refresh_token) {
            console.log('ℹ️ Novo refresh_token recebido (será usado em memória e tentaremos persistir no Render).');
            REFRESH_TOKEN = response.data.refresh_token;

            // tenta persistir no Render (não bloqueia a execução)
            updateRenderRefreshToken(REFRESH_TOKEN).catch(e => {
              console.warn('⚠️ updateRenderRefreshToken error:', e && e.message ? e.message : e);
            });
        }
        
        return accessToken;
    } catch (error) {
        if (error.response) {
            console.error('❌ Erro na autenticação. status:', error.response.status);
            console.error('❌ Corpo da resposta do Bling:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('❌ Erro na autenticação (sem response):', error.message);
        }
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
                timeout: 12000
            });

            const produtos = response.data.data || [];
            console.log(`📦 Página ${pagina}: ${produtos.length} produtos`);
            
            if (produtos.length === 0 || produtos.length < limite) {
                maisProdutos = false;
                console.log(`✅ Última página alcançada (página ${pagina})`);
            } else {
                pagina++;
            }
            
            todosProdutos = todosProdutos.concat(produtos);
            tentativasErro = 0;
            await new Promise(resolve => setTimeout(resolve, 400));
            
        } catch (error) {
            console.error(`❌ Erro na página ${pagina}:`, error.message);
            tentativasErro++;
            
            if (tentativasErro >= MAX_TENTATIVAS) {
                console.log(`🛑 Parando após ${MAX_TENTATIVAS} tentativas consecutivas`);
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
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
                <li>✅ <strong>Cache inteligente (10 min)</strong> - Performance mantida</li>
            </ul>
        </div>
        
        <h3>📊 Status:</h3>
        <ul>
            <li><strong>Cache:</strong> ${cacheValido() ? `✅ ${produtosCache.length} produtos (válido)` : '❌ Inválido'}</li>
            <li><strong>Access Token:</strong> ${accessToken ? '✅ Ativo' : '❌ Não autenticado'}</li>
            <li><strong>Versão:</strong> CORRIGIDA v4.1</li>
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
                timeout: 10000
            });

            accessToken = response.data.access_token;
            REFRESH_TOKEN = response.data.refresh_token;

            // tenta persistir no Render (se configurado)
            try {
              await updateRenderRefreshToken(REFRESH_TOKEN);
              console.log('✅ REFRESH_TOKEN persistido no Render via /callback.');
            } catch (e) {
              console.warn('⚠️ Falha ao persistir REFRESH_TOKEN no Render via /callback:', e && e.message ? e.message : e);
            }
            
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
                    <li>Vá ao Render > Environment Variables</li>
                    <li>Atualize REFRESH_TOKEN (se desejar)</li>
                    <li>Salve para redeploy</li>
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
    
    // Inicialização em background
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
});
