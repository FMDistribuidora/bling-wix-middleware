// index.js - CORRIGIDO v4.2 (exibe refresh_token completo no /callback)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// CORS liberado para qualquer origem
app.use(cors({ origin: '*' }));
app.use(express.json());

// Configurações do Bling
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
let REFRESH_TOKEN = process.env.REFRESH_TOKEN;

let accessToken = null;

// Cache TTL e preload
const DEFAULT_CACHE_TTL_MS = process.env.CACHE_TTL_MS ? Number(process.env.CACHE_TTL_MS) : (30 * 60 * 1000); // 30 min
const CACHE_TTL = DEFAULT_CACHE_TTL_MS;
const PRELOAD_CACHE = (process.env.PRELOAD_CACHE === 'true'); // default false

// Controle de concorrência
let refreshPromise = null;        // mutex para refresh token
let fetchInProgress = false;      // protege busca completa
let fetchPromise = null;

let produtosCache = [];
let cacheTimestamp = null;

// Validação ENV
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractRayIdFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const m1 = html.match(/Ray ID:?\s*([0-9a-f\-]{8,})/i) || html.match(/ID do Raio[:\s]*([0-9a-f]{8,})/i) || html.match(/Ray:\s*([0-9a-f]{8,})/i);
  return m1 ? m1[1] : null;
}

function isHtmlResponse(resp) {
  if (!resp) return false;
  const ct = resp.headers && resp.headers['content-type'];
  if (ct && ct.includes('text/html')) return true;
  if (typeof resp.data === 'string' && resp.data.trim().startsWith('<')) return true;
  return false;
}

/* ---------------------------
   Autenticação com Mutex (refresh)
   --------------------------- */
async function autenticarBling() {
  if (!REFRESH_TOKEN) throw new Error('REFRESH_TOKEN não configurado');

  // Se já tem refresh em andamento, aguarda e retorna o token
  if (refreshPromise) {
    console.log('🔁 Refresh em progresso, aguardando...');
    await refreshPromise;
    if (!accessToken) throw new Error('Falha no refresh (via wait)');
    return accessToken;
  }

  // Cria a promise de refresh (mutex)
  refreshPromise = (async () => {
    try {
      console.log('🔄 Autenticando com Bling (refresh_token)...');
      const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
      const base64Auth = Buffer.from(authString, 'utf8').toString('base64');

      const requestData = {
        grant_type: 'refresh_token',
        refresh_token: REFRESH_TOKEN
      };

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
        validateStatus: () => true
      });

      if (isHtmlResponse(response)) {
        const ray = extractRayIdFromHtml(response.data);
        console.error('❌ Possível bloqueio Cloudflare na autenticação. Ray ID:', ray || 'N/A');
        console.error('❌ Corpo (HTML) recebido do Bling (truncado):', String(response.data).substring(0,800));
        const err = new Error('Bloqueio Cloudflare detectado (Error 1015 ou similar).');
        err.code = 'CLOUDFLARE_BLOCK';
        err.rayId = ray;
        throw err;
      }

      if (response.status !== 200) {
        const body = response.data;
        if (body && (body.error && (body.error.tipo === 'invalid_grant' || body.error.type === 'invalid_grant'))) {
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
        // Atualiza em memória e orienta usuário a persistir
        const newRefresh = response.data.refresh_token;
        // Log mascarado
        const masked = newRefresh.length > 10 ? `${newRefresh.slice(0,6)}...${newRefresh.slice(-4)}` : '***';
        console.log('ℹ️ Novo refresh_token recebido (usar em memória). Atualize REFRESH_TOKEN no Render com este valor (mascarado):', masked);
        REFRESH_TOKEN = newRefresh;
      }

      return accessToken;
    } finally {
      // limpa mutex sempre
      refreshPromise = null;
    }
  })();

  return await refreshPromise;
}

/* ---------------------------
   Busca paginada com proteção contra rate-limit
   --------------------------- */
async function buscarProdutosBling() {
  console.log('🔍 Buscando TODOS os produtos no Bling...');

  let todosProdutos = [];
  let pagina = 1;
  const limite = process.env.BLING_PAGE_LIMIT ? Number(process.env.BLING_PAGE_LIMIT) : 50; // reduzir carga por página
  let maisProdutos = true;
  let tentativasErro = 0;
  const MAX_TENTATIVAS = 3;

  while (maisProdutos && tentativasErro < MAX_TENTATIVAS) {
    try {
      console.log(`📄 Buscando página ${pagina}...`);

      const response = await axios({
        method: 'GET',
        url: `https://api.bling.com.br/Api/v3/produtos`,
        params: { pagina: pagina, limite: limite },
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': '1.0',
          'User-Agent': 'Bling-Wix-Integration/1.0'
        },
        timeout: 15000,
        validateStatus: () => true
      });

      if (isHtmlResponse(response)) {
        const ray = extractRayIdFromHtml(response.data);
        console.error('❌ Bloqueio Cloudflare detectado ao buscar produtos. Ray ID:', ray || 'N/A');
        console.error('❌ Corpo (HTML) recebido do Bling (truncado):', String(response.data).substring(0,800));
        const err = new Error('Bloqueio Cloudflare detectado (Error 1015).');
        err.code = 'CLOUDFLARE_BLOCK';
        err.rayId = ray;
        throw err;
      }

      if (response.status === 401) {
        console.error('❌ 401 ao buscar produtos — access token inválido/expirado. Forçando reautenticação.');
        await autenticarBling();
        continue;
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

      // atraso entre páginas para reduzir chance de rate-limit
      await sleep(600);
    } catch (error) {
      console.error(`❌ Erro na página ${pagina}:`, error.message);
      tentativasErro++;

      if (error.code === 'INVALID_GRANT') {
        console.error('❌ invalid_grant detectado durante busca. Atualize REFRESH_TOKEN via /auth e no Render.');
        throw error;
      }

      if (error.code === 'CLOUDFLARE_BLOCK') {
        console.error('❌ Abortando busca devido a bloqueio Cloudflare. Aguarde liberação/desbloqueio com o suporte do Bling.');
        throw error;
      }

      if (error.code === 'RATE_LIMIT' || (error.response && error.response.status === 429)) {
        const backoffMs = Math.min(60 * 1000, 1000 * Math.pow(2, tentativasErro)); // cap 60s
        console.warn(`⚠️ Rate limited. Esperando ${backoffMs}ms antes de tentar novamente... (tentativa ${tentativasErro}/${MAX_TENTATIVAS})`);
        await sleep(backoffMs);
      } else {
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

// Cache valido
function cacheValido() {
  return cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL;
}

// Rotas
app.get('/', (req, res) => {
  res.send(`
    <h1>🔗 Bling-Wix Integration API</h1>
    <h2>✅ Sistema Online - VERSÃO CORRIGIDA v4.2</h2>
    <ul>
      <li>PRELOAD_CACHE: ${PRELOAD_CACHE}</li>
      <li>CACHE_TTL_MS: ${CACHE_TTL}</li>
      <li>BLING_PAGE_LIMIT: ${process.env.BLING_PAGE_LIMIT || 50}</li>
    </ul>
    <p>Endpoints: /produtos /autenticar /auth /ping</p>
  `);
});

app.get('/autenticar', async (req, res) => {
  try {
    await autenticarBling();
    res.json({ sucesso: true, mensagem: '✅ Autenticação realizada com sucesso!', timestamp: new Date().toISOString() });
  } catch (error) {
    const body = { erro: error.message, code: error.code || null, rayId: error.rayId || null, timestamp: new Date().toISOString() };
    const status = error.code === 'INVALID_GRANT' ? 400 : (error.code === 'CLOUDFLARE_BLOCK' ? 502 : 500);
    res.status(status).json(body);
  }
});

app.get('/auth', (req, res) => {
  const authUrl = `https://api.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=bling_wix_integration`;
  res.send(`<h1>🔐 Autorização OAuth - Bling</h1><a href="${authUrl}" target="_blank">🔑 Autorizar no Bling</a>`);
});

// ALTERAÇÃO: Exibe o refresh_token COMPLETO na tela do /callback
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>❌ Erro: ${error}</h2>`);
  if (!code) return res.send('<h2>❌ Sem code</h2>');

  try {
    const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
    const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
    const requestData = { grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT_URI };

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
      validateStatus: () => true
    });

    if (isHtmlResponse(response)) {
      const ray = extractRayIdFromHtml(response.data);
      console.error('❌ Cloudflare block on token exchange. Ray ID:', ray);
      return res.send(`<h2>❌ Cloudflare block detected. Ray ID: ${ray || 'N/A'}</h2>`);
    }

    if (response.status !== 200) {
      console.error('❌ Erro ao gerar token (callback). status:', response.status);
      console.error('❌ Corpo:', typeof response.data === 'object' ? JSON.stringify(response.data, null, 2) : String(response.data).substring(0,800));
      return res.send(`<h2>❌ Erro ao gerar token: status ${response.status}</h2>`);
    }

    accessToken = response.data.access_token;
    REFRESH_TOKEN = response.data.refresh_token;

    // Exibe o refresh_token COMPLETO na tela (sem mascarar)
    res.send(`
      <h2>✅ REFRESH_TOKEN gerado!</h2>
      <div style="background: #f8f9fa; padding: 15px; margin: 15px 0;">
          <h3>🔑 Novo REFRESH_TOKEN (completo):</h3>
          <code style="background: #e9ecef; padding: 8px; display: block; word-break: break-all; font-size: 1.1em; color: #222;">
              ${REFRESH_TOKEN}
          </code>
      </div>
      <h3>📋 Instruções:</h3>
      <ol>
          <li>Copie o token acima (tudo, sem espaços extras)</li>
          <li>Vá ao Render → Environment Variables</li>
          <li>Atualize REFRESH_TOKEN</li>
          <li>Salve e redeploy</li>
      </ol>
    `);
  } catch (tokenError) {
    console.error('❌ Erro ao gerar token (callback):', tokenError.response ? tokenError.response.data : tokenError.message);
    res.send(`<h2>❌ Erro ao gerar token: ${tokenError.message}</h2>`);
  }
});

app.get('/produtos', async (req, res) => {
  try {
    console.log('📦 Endpoint /produtos chamado (VERSÃO CORRIGIDA)');

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, User-Agent');

    if (cacheValido()) {
      console.log(`✅ Usando cache: ${produtosCache.length} produtos`);
      return res.json({
        sucesso: true, produtos: produtosCache, total: produtosCache.length, fonte: 'cache', versao: 'CORRIGIDA v4.2',
        timestamp: new Date().toISOString(), cache_info: { criado_em: new Date(cacheTimestamp).toISOString(), valido_ate: new Date(cacheTimestamp + CACHE_TTL).toISOString() }
      });
    }

    // Se uma busca já está em progresso, aguarda e retorna resultado ou fallback
    if (fetchInProgress && fetchPromise) {
      console.log('⏳ Busca já em andamento, aguardando resultado existente...');
      try {
        const produtos = await fetchPromise;
        return res.json({ sucesso: true, produtos, total: produtos.length, fonte: 'concurrent_fetch_result', versao: 'CORRIGIDA v4.2' });
      } catch (err) {
        if (produtosCache.length > 0) {
          return res.json({ sucesso: true, produtos: produtosCache, total: produtosCache.length, fonte: 'cache_fallback', versao: 'CORRIGIDA v4.2' });
        }
        throw err;
      }
    }

    // inicia fetch protegido
    fetchInProgress = true;
    fetchPromise = (async () => {
      try {
        await autenticarBling();
        const produtos = await buscarProdutosBling();
        produtosCache = produtos;
        cacheTimestamp = Date.now();
        console.log(`✅ Cache atualizado: ${produtos.length} produtos`);
        return produtos;
      } finally {
        fetchInProgress = false;
        fetchPromise = null;
      }
    })();

    const produtos = await fetchPromise;

    res.json({
      sucesso: true, produtos, total: produtos.length, fonte: 'bling_direto', versao: 'CORRIGIDA v4.2',
      timestamp: new Date().toISOString(), cache_info: { atualizado_agora: true, valido_ate: new Date(cacheTimestamp + CACHE_TTL).toISOString() }
    });
  } catch (error) {
    console.error('❌ Erro no endpoint /produtos:', error.message);

    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, User-Agent');

    if (error.code === 'INVALID_GRANT') {
      return res.status(400).json({ erro: 'invalid_grant', mensagem: 'Refresh token inválido. Gere novo via /auth e atualize REFRESH_TOKEN no Render.', timestamp: new Date().toISOString() });
    }

    if (error.code === 'CLOUDFLARE_BLOCK') {
      return res.status(502).json({ erro: 'cloudflare_block', mensagem: 'Bloqueio detectado (Cloudflare). Pare o job e contate o Bling com o Ray ID.', rayId: error.rayId || null, timestamp: new Date().toISOString() });
    }

    if (produtosCache.length > 0) {
      return res.json({ sucesso: true, produtos: produtosCache, total: produtosCache.length, fonte: 'cache_fallback', versao: 'CORRIGIDA v4.2', aviso: 'Dados do cache devido a erro na API' });
    }

    res.status(500).json({ erro: error.message, produtos: [], total: 0, versao: 'CORRIGIDA v4.2', timestamp: new Date().toISOString() });
  }
});

app.get('/ping', (req, res) => {
  res.json({ status: 'alive', versao: 'CORRIGIDA v4.2', timestamp: new Date().toISOString(), cache: { produtos: produtosCache.length, valido: cacheValido(), timestamp: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null } });
});

app.listen(PORT, async () => {
  console.log(`🚀 Servidor CORRIGIDO rodando na porta ${PORT}`);
  console.log(`🎉 VERSÃO: CORRIGIDA v4.2`);
  if (PRELOAD_CACHE) {
    console.log('🔄 PRELOAD_CACHE=true → inicializando cache agora...');
    try {
      await autenticarBling();
      const produtos = await buscarProdutosBling();
      produtosCache = produtos;
      cacheTimestamp = Date.now();
      console.log(`✅ Cache inicializado: ${produtos.length} produtos`);
    } catch (err) {
      console.log('⚠️ Falha na inicialização do cache:', err.message);
    }
  } else {
    console.log('ℹ️ PRELOAD_CACHE=false → não inicializando cache automaticamente.');
  }
});
