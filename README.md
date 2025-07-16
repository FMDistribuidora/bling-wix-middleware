# Middleware Bling → Wix

Este middleware consulta os produtos do Bling via OAuth 2.0 e envia para o endpoint do Wix Velo.

## Endpoints
- `/autenticar` → Inicia o login com o Bling
- `/callback` → Recebe o token de acesso
- `/enviar-wix` → Consulta o estoque do Bling e envia ao Wix

## Como rodar no Render.com
1. Crie novo Web Service
2. Configure as variáveis de ambiente conforme o `.env.example`
3. Use `npm install` como Build Command
4. Use `npm start` como Start Command