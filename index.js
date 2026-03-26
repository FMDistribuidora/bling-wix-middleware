const response = await axios({
  method: 'POST',
  url: 'https://api.bling.com.br/Api/v3/oauth/token',
  data: qs.stringify(requestData),
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${base64Auth}`,
    'Accept': '1.0',
    'User-Agent': 'Bling-Wix-Integration/1.0',
    'enable-jwt': '1' // <-- Adicione esta linha!
  },
  timeout: 15000,
  validateStatus: () => true
});
