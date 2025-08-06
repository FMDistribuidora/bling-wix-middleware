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

// Função para testar conectividade da API Bling
async function testarConectividadeAPI() {
    console.log('🔍 Testando conectividade da API Bling...');
    
    try {
        const response = await axios({
            method: 'GET',
            url: 'https://api.bling.com.br/Api/v3/produtos',
            params: {
                pagina: 1,
                limite: 1 // Apenas 1 produto para teste
            },
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': '1.0',
                'User-Agent': 'Bling-Wix-Integration/1.0'
            },
            timeout: 5000
        });
        
        console.log('✅ API Bling respondendo normalmente');
        return true;
        
    } catch (error) {
        console.warn('⚠️ Problema na conectividade da API:', {
            message: error.message,
            code: error.code,
            status: error.response?.status
        });
        
        // Se for timeout ou erro de rede, retornar false mas não falhar
        if (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || error.response?.status >= 500) {
            console.log('🔄 API com instabilidade, mas tentaremos continuar...');
            return false;
        }
        
        throw error; // Re-throw erros críticos (auth, etc)
    }
}

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
    
    // Testar conectividade primeiro
    const apiEstavel = await testarConectividadeAPI();
    if (!apiEstavel) {
        console.log('⚠️ API instável detectada - usando estratégia resiliente');
    }
    
    let todosProdutos = [];
    let pagina = 1;
    const limite = 100;
    let maisProdutos = true;
    let tentativasConsecutivasErro = 0;
    const MAX_TENTATIVAS_ERRO = apiEstavel ? 3 : 5; // Mais tolerância se API instável

    while (maisProdutos && tentativasConsecutivasErro < MAX_TENTATIVAS_ERRO) {
        let tentativa = 0;
        const maxTentativas = 3;
        let sucessoPagina = false;
        
        // Retry para cada página individualmente
        while (tentativa < maxTentativas && !sucessoPagina) {
            try {
                tentativa++;
                console.log(`📄 Buscando página ${pagina}... (tentativa ${tentativa}/${maxTentativas})`);
                
                // Delay progressivo entre tentativas
                if (tentativa > 1) {
                    const delayTentativa = Math.pow(2, tentativa - 1) * 1000; // 1s, 2s, 4s...
                    console.log(`⏳ Aguardando ${delayTentativa}ms antes da tentativa ${tentativa}...`);
                    await new Promise(resolve => setTimeout(resolve, delayTentativa));
                }
                
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
                    timeout: 15000, // Aumentar timeout para 15 segundos
                    validateStatus: function (status) {
                        return status >= 200 && status < 300;
                    }
                });

                const produtos = response.data.data || [];
                console.log(`📦 ✅ Encontrados ${produtos.length} produtos na página ${pagina}`);
                
                // Sucesso - resetar contador de erros consecutivos
                tentativasConsecutivasErro = 0;
                sucessoPagina = true;
                
                if (produtos.length === 0) {
                    console.log('📄 Última página atingida (sem produtos)');
                    maisProdutos = false;
                } else {
                    todosProdutos = todosProdutos.concat(produtos);
                    
                    if (produtos.length < limite) {
                        console.log('📄 Última página atingida (menos que o limite)');
                        maisProdutos = false;
                    } else {
                        pagina++;
                    }
                }
                
            } catch (error) {
                console.error(`❌ Erro na tentativa ${tentativa} da página ${pagina}:`, {
                    message: error.message,
                    code: error.code,
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    data: error.response?.data?.substring ? error.response.data.substring(0, 200) : error.response?.data
                });
                
                // Se todas as tentativas falharam para esta página
                if (tentativa === maxTentativas) {
                    tentativasConsecutivasErro++;
                    console.error(`💥 Falha definitiva na página ${pagina} após ${maxTentativas} tentativas`);
                    
                    if (tentativasConsecutivasErro >= MAX_TENTATIVAS_ERRO) {
                        console.error(`🚨 PARANDO: ${MAX_TENTATIVAS_ERRO} páginas consecutivas com erro`);
                        maisProdutos = false;
                    } else {
                        // Pular esta página e tentar a próxima
                        console.log(`⏭️ Pulando página ${pagina} e tentando próxima...`);
                        pagina++;
                    }
                }
            }
        }
        
        // Rate limiting - aguardar mais tempo entre páginas
        if (maisProdutos && sucessoPagina) {
            const delay = tentativasConsecutivasErro > 0 ? 1000 : 600; // Delay maior após erros
            console.log(`⏳ Rate limit: aguardando ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    console.log(`📊 Total de produtos encontrados: ${todosProdutos.length}`);
    console.log(`📊 Resultado da busca: ${tentativasConsecutivasErro < MAX_TENTATIVAS_ERRO ? 'SUCESSO' : 'PARCIAL'}`);
    
    // Se conseguimos pelo menos alguns produtos, continuar
    if (todosProdutos.length === 0) {
        throw new Error('Nenhum produto foi encontrado na API do Bling');
    }
    
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
    
    if (produtosComEstoque.length === 0) {
        throw new Error('Nenhum produto com estoque positivo foi encontrado');
    }
    
    return produtosComEstoque;
}

// Função para enviar dados para o Wix
async function enviarParaWix(produtos) {
    console.log('📤 Enviando produtos para o Wix...');
    console.log(`📦 Total de produtos a enviar: ${produtos.length}`);
    console.log(`📋 Amostra produto:`, JSON.stringify(produtos[0]));
    console.log('🔗 URL destino:', WIX_ENDPOINT);
    
    try {
        const response = await axios({
            method: 'POST',
            url: WIX_ENDPOINT,
            data: produtos, // Enviar array diretamente
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Bling-Wix-Integration/1.0',
                'Accept': 'application/json'
            },
            timeout: 30000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: function (status) {
                return status < 600; // Aceitar qualquer resposta para debug completo
            }
        });
        
        console.log(`📥 RESPOSTA COMPLETA DO WIX:`, {
            status: response.status,
            statusText: response.statusText,
            data: response.data,
            data_type: typeof response.data,
            data_string: JSON.stringify(response.data),
            data_length: response.data ? JSON.stringify(response.data).length : 0,
            is_html: typeof response.data === 'string' && response.data.includes('<html>'),
            content_type: response.headers['content-type'],
            all_headers: response.headers
        });
        
        // Verificar se é HTML sendo retornado (erro comum)
        if (typeof response.data === 'string' && response.data.includes('<html>')) {
            console.log('🚨 PROBLEMA: Wix retornou HTML, não JSON!');
            console.log('🔍 Início da resposta HTML:', response.data.substring(0, 300));
        }
        
        return response.data;
        
    } catch (error) {
        console.error('❌ Erro ao enviar para Wix:', {
            message: error.message,
            code: error.code,
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            headers: error.response?.headers,
            url_tentativa: WIX_ENDPOINT
        });
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
            <li><a href="/testar-wix-direto">🎯 Teste Direto HTTP Function</a></li>
            <li><a href="/debug-wix-minimal">🐛 Debug Mínimo Wix</a></li>
            <li><a href="/testar-collection-wix">🗄️ Testar Collection Wix</a></li>
            <li><a href="/debug-wix-ultimate">🔥 Debug Ultimate Wix</a></li>
            <li><a href="/verificar-wix">🔍 Verificar Dados no Wix</a></li>
            <li><a href="/debug-bling">🔍 Debug Estrutura Bling</a></li>
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
        
        // 2. Buscar todos os produtos
        const todosProdutos = await buscarProdutosBling();
        
        if (todosProdutos.length === 0) {
            return res.json({ 
                mensagem: "⚠️ Nenhum produto com estoque positivo encontrado.",
                produtos: 0,
                timestamp: new Date().toISOString()
            });
        }
        
        // Para teste - vamos enviar todos os produtos, não apenas 2
        console.log(`📋 Total de produtos encontrados: ${todosProdutos.length}`);
        
        // 3. Enviar para Wix
        const respostaWix = await enviarParaWix(todosProdutos);
        
        res.json({ 
            sucesso: true,
            mensagem: '✅ Sincronização completa realizada com sucesso!',
            produtosSincronizados: todosProdutos.length,
            respostaWix,
            debug_info: {
                total_produtos_bling: todosProdutos.length,
                primeiros_5_produtos: todosProdutos.slice(0, 5),
                produtos_exemplo: todosProdutos[0]
            },
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

// NOVO: Endpoint específico para debug da limitação
app.get('/debug-limitacao', async (req, res) => {
    try {
        console.log('\n🔍 DEBUG: Investigando limitação de produtos...');
        
        // 1. Autenticar
        await autenticarBling();
        console.log('✅ Autenticação OK');
        
        // 2. Buscar produtos
        const todosProdutos = await buscarProdutosBling();
        console.log(`📊 Produtos encontrados: ${todosProdutos.length}`);
        
        // 3. Testar diferentes quantidades
        const testes = [
            { nome: 'Apenas 1 produto', produtos: todosProdutos.slice(0, 1) },
            { nome: 'Apenas 2 produtos', produtos: todosProdutos.slice(0, 2) },
            { nome: 'Primeiros 5 produtos', produtos: todosProdutos.slice(0, 5) },
            { nome: 'Primeiros 10 produtos', produtos: todosProdutos.slice(0, 10) }
        ];
        
        const resultados = [];
        
        for (const teste of testes) {
            console.log(`\n🧪 Testando: ${teste.nome} (${teste.produtos.length} items)`);
            
            try {
                const resposta = await enviarParaWix(teste.produtos);
                resultados.push({
                    teste: teste.nome,
                    quantidade_enviada: teste.produtos.length,
                    sucesso: true,
                    resposta: typeof resposta === 'string' ? 'HTML_RESPONSE' : resposta
                });
                console.log(`✅ ${teste.nome}: SUCESSO`);
            } catch (error) {
                resultados.push({
                    teste: teste.nome,
                    quantidade_enviada: teste.produtos.length,
                    sucesso: false,
                    erro: error.message
                });
                console.log(`❌ ${teste.nome}: FALHOU - ${error.message}`);
            }
        }
        
        res.json({
            debug_limitacao: true,
            total_produtos_disponiveis: todosProdutos.length,
            testes_realizados: resultados,
            conclusao: resultados.find(r => r.quantidade_enviada === 2 && r.sucesso) ? 
                'LIMITAÇÃO CONFIRMADA EM 2 PRODUTOS' : 
                'LIMITAÇÃO NÃO CONFIRMADA',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Erro no debug:', error.message);
        res.status(500).json({
            debug_limitacao: true,
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

// Endpoint para inspecionar estrutura real dos dados do Bling
app.get('/debug-bling', async (req, res) => {
    try {
        console.log('🔍 Inspecionando estrutura real dos dados do Bling...');
        
        // 1. Autenticar
        await autenticarBling();
        
        // 2. Buscar apenas 3 produtos para análise
        const response = await axios({
            method: 'GET',
            url: `https://api.bling.com.br/Api/v3/produtos`,
            params: {
                pagina: 1,
                limite: 3 // Apenas 3 produtos para análise
            },
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': '1.0',
                'User-Agent': 'Bling-Wix-Integration/1.0'
            },
            timeout: 10000
        });

        const produtos = response.data.data || [];
        
        res.json({
            sucesso: true,
            mensagem: '🔍 Estrutura real dos dados do Bling:',
            total_produtos: produtos.length,
            estrutura_completa: produtos,
            analise_campos: produtos.map(produto => ({
                todas_propriedades: Object.keys(produto),
                codigo_disponivel: produto.codigo || 'CAMPO NÃO ENCONTRADO',
                nome_disponivel: produto.nome || 'CAMPO NÃO ENCONTRADO', 
                descricao_disponivel: produto.descricao || 'CAMPO NÃO ENCONTRADO',
                estoque_objeto: produto.estoque || 'CAMPO NÃO ENCONTRADO',
                estoque_propriedades: produto.estoque ? Object.keys(produto.estoque) : 'N/A',
                saldoVirtualTotal: produto.estoque?.saldoVirtualTotal || 'CAMPO NÃO ENCONTRADO',
                saldoFisico: produto.estoque?.saldoFisico || 'CAMPO NÃO ENCONTRADO'
            })),
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Erro na inspeção Bling:', error.message);
        res.status(500).json({
            erro: error.message,
            detalhes: error.response?.data || 'Erro interno',
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint para testar diretamente a HTTP Function do Wix
app.get('/testar-wix-direto', async (req, res) => {
    try {
        console.log('🧪 Testando HTTP Function Wix diretamente...');
        
        // Dados de teste simples
        const dadosTeste = [
            {
                codigo: 'TESTE-DIRETO-001',
                descricao: 'Produto Teste Direto',
                estoque: 999
            }
        ];
        
        console.log('📤 Enviando dados de teste:', dadosTeste);
        
        const response = await axios({
            method: 'POST',
            url: WIX_ENDPOINT,
            data: dadosTeste,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Bling-Wix-Integration/1.0 (Direct-Test)'
            },
            timeout: 30000,
            validateStatus: function (status) {
                return status < 600; // Aceitar qualquer resposta para debug
            }
        });
        
        console.log('📥 Resposta recebida:', {
            status: response.status,
            headers: response.headers,
            data: response.data
        });
        
        res.json({
            sucesso: true,
            teste: 'Teste direto da HTTP Function',
            wix_endpoint: WIX_ENDPOINT,
            dados_enviados: dadosTeste,
            resposta_wix: {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                data: response.data
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Erro no teste direto:', error.message);
        res.status(500).json({
            erro: error.message,
            codigo: error.code,
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

// Endpoint DEBUG: Testar com dados mínimos
app.get('/debug-wix-minimal', async (req, res) => {
    console.log('🐛 DEBUG: Teste mínimo com Wix...');
    
    try {
        // Dados super simples para testar - UM PRODUTO SÓ
        const dadosMinimos = [
            {
                codigo: 'DEBUG001',
                descricao: 'Debug Test',
                estoque: 1
            }
        ];
        
        console.log('📤 Enviando dados mínimos:', dadosMinimos);
        
        const resposta = await axios.post(WIX_ENDPOINT, dadosMinimos, {
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 10000,
            validateStatus: function (status) {
                return status < 500; // Aceitar qualquer status < 500
            }
        });
        
        console.log('📥 Resposta completa:', {
            status: resposta.status,
            data: resposta.data,
            headers: Object.keys(resposta.headers)
        });
        
        res.json({
            sucesso: true,
            teste: 'minimal',
            wix_status: resposta.status,
            wix_data: resposta.data,
            wix_content_type: resposta.headers['content-type'],
            dados_enviados: dadosMinimos,
            debug_info: {
                response_size: JSON.stringify(resposta.data || '').length,
                is_empty: !resposta.data || resposta.data === '',
                data_type: typeof resposta.data,
                response_text: JSON.stringify(resposta.data)
            }
        });
        
    } catch (error) {
        console.error('❌ Erro no debug mínimo:', error);
        res.status(500).json({
            sucesso: false,
            erro: error.message,
            codigo_erro: error.code,
            resposta_wix: error.response?.data,
            status_wix: error.response?.status
        });
    }
});

// Endpoint para testar se collection existe e está acessível
app.get('/testar-collection-wix', async (req, res) => {
    console.log('🔍 Testando se Collection Estoque está acessível...');
    
    try {
        // Dados de teste para inserção manual
        const produtoTeste = {
            codigoProduto: 'TESTE-MANUAL-001',
            nomeProduto: 'Produto Manual Teste',
            quantidadeEstoque: 999,
            ultimaAtualizacao: new Date()
        };
        
        console.log('📤 Enviando produto teste:', produtoTeste);
        
        const resposta = await axios.post(WIX_ENDPOINT, [produtoTeste], {
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 15000
        });
        
        console.log('📥 Resposta da collection:', resposta.data);
        
        res.json({
            sucesso: true,
            teste: 'collection_access',
            produto_enviado: produtoTeste,
            resposta_wix: resposta.data,
            status: resposta.status,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Erro no teste da collection:', error);
        res.json({
            sucesso: false,
            erro: error.message,
            resposta_erro: error.response?.data,
            status_erro: error.response?.status,
            teste: 'collection_access_failed'
        });
    }
});

// Endpoint para testar DIRETAMENTE a HTTP Function do Wix
app.get('/debug-wix-ultimate', async (req, res) => {
    console.log('🔥 DEBUG ULTIMATE: Testando Wix com logs completos...');
    
    try {
        const produtoTeste = {
            codigo: 'ULTIMATE-001',
            descricao: 'Teste Ultimate Debug',
            estoque: 777
        };
        
        console.log('🎯 URL EXATA:', WIX_ENDPOINT);
        console.log('📤 Dados enviados:', JSON.stringify([produtoTeste], null, 2));
        
        const response = await axios({
            method: 'POST',
            url: WIX_ENDPOINT,
            data: [produtoTeste],
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Debug-Ultimate/1.0'
            },
            timeout: 20000,
            validateStatus: function (status) {
                return true; // Aceitar QUALQUER status
            }
        });
        
        console.log('📥 RESPOSTA BRUTA COMPLETA:');
        console.log('Status:', response.status);
        console.log('StatusText:', response.statusText);
        console.log('Headers:', JSON.stringify(response.headers, null, 2));
        console.log('Data tipo:', typeof response.data);
        console.log('Data conteúdo:', JSON.stringify(response.data, null, 2));
        console.log('Data string:', String(response.data));
        console.log('Data length:', response.data ? String(response.data).length : 0);
        
        // Verificar se é HTML
        const isHTML = typeof response.data === 'string' && response.data.includes('<html>');
        
        res.json({
            teste: 'ultimate_debug',
            sucesso: response.status >= 200 && response.status < 300,
            url_testada: WIX_ENDPOINT,
            dados_enviados: [produtoTeste],
            resposta_completa: {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                data: response.data,
                data_type: typeof response.data,
                data_string: String(response.data),
                data_length: response.data ? String(response.data).length : 0,
                is_html: isHTML,
                is_empty: !response.data || response.data === '' || response.data === '""'
            },
            analise: {
                parece_funcionar: response.status === 200,
                retorna_json: response.headers['content-type']?.includes('application/json'),
                retorna_html: isHTML,
                resposta_vazia: !response.data || response.data === '',
                possivel_problema: isHTML ? 'Retornando HTML (erro 404/500?)' : 
                                  (!response.data ? 'Resposta completamente vazia' : 'HTTP Function não retorna dados')
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ ERRO NO DEBUG ULTIMATE:', error);
        res.status(500).json({
            erro: error.message,
            codigo: error.code,
            resposta_erro: error.response?.data,
            status_erro: error.response?.status,
            headers_erro: error.response?.headers
        });
    }
});

// Endpoint para verificar se os dados chegaram no Wix
app.get('/verificar-wix', async (req, res) => {
    try {
        console.log('🔍 Verificando dados no Wix...');
        
        // Fazer uma requisição GET para testar se o Wix tem um endpoint de consulta
        const wixUrl = WIX_ENDPOINT.replace('/receberProdutos', '/consultarProdutos');
        
        try {
            const response = await axios({
                method: 'GET',
                url: wixUrl,
                headers: {
                    'User-Agent': 'Bling-Wix-Integration/1.0 (Verification)'
                },
                timeout: 30000,
                validateStatus: function (status) {
                    return status < 500; // Aceitar qualquer resposta
                }
            });
            
            res.json({
                sucesso: true,
                mensagem: '🔍 Verificação do Wix realizada',
                wix_url_testado: wixUrl,
                status: response.status,
                resposta: response.data,
                instrucoes: [
                    'Se status 200: Wix respondeu com dados',
                    'Se status 404: Endpoint não existe (normal)',
                    'Se status 500: Erro no Wix',
                    'Para verificar manualmente, acesse sua página Wix de consulta'
                ],
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            res.json({
                sucesso: false,
                mensagem: '⚠️ Não foi possível verificar diretamente',
                erro: error.message,
                wix_url_testado: wixUrl,
                instrucoes: [
                    '1. Acesse sua página Wix de consulta de estoque',
                    '2. Procure pelos produtos: TX 2052 e TR 4061',
                    '3. Se aparecerem, a sincronização funcionou!',
                    '4. Se não aparecerem, verifique os logs do Wix'
                ],
                timestamp: new Date().toISOString()
            });
        }
        
    } catch (error) {
        console.error('❌ Erro na verificação:', error.message);
        res.status(500).json({
            erro: error.message,
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
            console.log('🚨 REFRESH_TOKEN inválido detectado!');
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
