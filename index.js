// index.js - VERSÃO OTIMIZADA PARA RENDER COM CORS LIBERADO
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');
const cors = require('cors'); // ADICIONADO

const app = express();
const PORT = process.env.PORT || 10000;

// CORS liberado para qualquer origem (ou especifique seu domínio Wix)
app.use(cors({
  origin: '*', // Para produção, use: 'https://www.fmpapeisdeparede.com.br'
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

// Função para autenticar com o Bling usando refresh_token
async function autenticarBling() {
    if (!REFRESH_TOKEN) {
        throw new Error('REFRESH_TOKEN não configurado');
    }

    console.log('🔄 Autenticando com Bling...');
    
    try {
        const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
        const base64Auth = Buffer.from(authString, 'utf8').toString('base64');
        
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
        
        if (response.data.refresh_token) {
            REFRESH_TOKEN = response.data.refresh_token;
        }
        
        return accessToken;
    } catch (error) {
        console.error('❌ Erro na autenticação:', error.message);
        throw error;
    }
}

// Função otimizada para buscar produtos com timeout menor
async function buscarProdutosBling() {
    console.log('🔍 Buscando produtos no Bling (versão otimizada)...');
    
    let todosProdutos = [];
    let pagina = 1;
    const limite = 100;
    let maisProdutos = true;
    let tentativasErro = 0;
    const MAX_TENTATIVAS = 3;
    const MAX_PAGINAS = 20; // Limitar para evitar timeout

    while (maisProdutos && tentativasErro < MAX_TENTATIVAS && pagina <= MAX_PAGINAS) {
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
                timeout: 8000 // Timeout menor
            });

            const produtos = response.data.data || [];
            console.log(`📦 Página ${pagina}: ${produtos.length} produtos`);
            
            if (produtos.length === 0 || produtos.length < limite) {
                maisProdutos = false;
            } else {
                pagina++;
            }
            
            todosProdutos = todosProdutos.concat(produtos);
            tentativasErro = 0; // Reset contador
            
            // Rate limiting reduzido
            await new Promise(resolve => setTimeout(resolve, 300));
            
        } catch (error) {
            console.error(`❌ Erro na página ${pagina}:`, error.message);
            tentativasErro++;
            
            if (tentativasErro >= MAX_TENTATIVAS) {
                console.log(`🛑 Parando após ${MAX_TENTATIVAS} tentativas consecutivas`);
                break;
            }
            
            // Aguardar antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    console.log(`📊 Total de produtos encontrados: ${todosProdutos.length}`);
    
    // Filtrar produtos com estoque
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

// Verificar se cache é válido
function cacheValido() {
    return cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL;
}

// Página inicial
app.get('/', (req, res) => {
    res.send(`
        <h1>🔗 Bling-Wix Integration API</h1>
        <h2>✅ Sistema Online - VERSÃO OTIMIZADA v4.0</h2>
        
        <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; margin: 15px 0; border-radius: 5px;">
            <h3>🚀 NOVA ABORDAGEM - WIX BUSCA DADOS:</h3>
            <ul>
                <li>✅ <strong>Endpoint /produtos otimizado</strong> - Performance melhorada</li>
                <li>✅ <strong>Cache inteligente (10 min)</strong> - Evita timeouts</li>
                <li>✅ <strong>Timeout otimizado</strong> - Resposta mais rápida</li>
                <li>✅ <strong>Dados sempre atualizados</strong> - Direto do Bling</li>
            </ul>
        </div>
        
        <h3>📊 Status:</h3>
        <ul>
            <li><strong>Cache:</strong> ${cacheValido() ? `✅ ${produtosCache.length} produtos (válido)` : '❌ Inválido'}</li>
            <li><strong>Access Token:</strong> ${accessToken ? '✅ Ativo' : '❌ Não autenticado'}</li>
            <li><strong>Versão:</strong> OTIMIZADA v4.0</li>
        </ul>
        
        <h3>🔧 Endpoints:</h3>
        <ul>
            <li><a href="/produtos" style="background: #007bff; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px;">📦 Produtos (PRINCIPAL)</a></li>
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
                    <li>Atualize REFRESH_TOKEN</li>
                    <li>Salve para redeploy</li>
                </ol>
            `);
            
        } catch (tokenError) {
            res.send(`<h2>❌ Erro ao gerar token: ${tokenError.message}</h2>`);
        }
    }
});

// ENDPOINT PRINCIPAL OTIMIZADO
app.get('/produtos', async (req, res) => {
    try {
        console.log('📦 Endpoint /produtos chamado (OTIMIZADO)');
        
        // CORS headers (redundante, mas garante em todas respostas)
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
                versao: 'OTIMIZADA v4.0',
                timestamp: new Date().toISOString(),
                cache_info: {
                    criado_em: new Date(cacheTimestamp).toISOString(),
                    valido_ate: new Date(cacheTimestamp + CACHE_TTL).toISOString()
                }
            });
        }
        
        console.log('🔄 Cache expirado, buscando dados atualizados...');
        
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
            versao: 'OTIMIZADA v4.0',
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
                versao: 'OTIMIZADA v4.0',
                timestamp: new Date().toISOString(),
                aviso: 'Dados do cache devido a erro na API'
            });
        }
        
        // Última opção: erro
        res.status(500).json({ 
            erro: error.message,
            produtos: [],
            total: 0,
            versao: 'OTIMIZADA v4.0',
            timestamp: new Date().toISOString()
        });
    }
});

// Keep alive
app.get('/ping', (req, res) => {
    res.json({
        status: 'alive',
        versao: 'OTIMIZADA v4.0',
        timestamp: new Date().toISOString(),
        cache: {
            produtos: produtosCache.length,
            valido: cacheValido(),
            timestamp: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null
        }
    });
});

// Inicialização otimizada
app.listen(PORT, async () => {
    console.log(`🚀 Servidor OTIMIZADO rodando na porta ${PORT}`);
    console.log(`🌐 URL: https://bling-wix-middleware.onrender.com`);
    console.log(`🎉 VERSÃO: OTIMIZADA v4.0 - Cache inteligente + timeouts reduzidos`);
    
    // Inicialização em background para não bloquear o startup
    setTimeout(async () => {
        try {
            console.log('🔄 Inicializando cache em background...');
            await autenticarBling();
            const produtos = await buscarProdutosBling();
            produtosCache = produtos;
            cacheTimestamp = Date.now();
            console.log(`✅ Cache inicializado: ${produtos.length} produtos`);
        } catch (error) {
            console.log('⚠️ Falha na inicialização do cache:', error.message);
            console.log('🟡 Sistema funcionará com cache sob demanda');
        }
    }, 2000); // Aguardar 2 segundos após startup
});
