import axios from 'axios';

// Na versão 54/55 do Expo, as variáveis de ambiente prefixadas com EXPO_PUBLIC_ são expostas automaticamente
const api = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_URL,
  timeout: 120000, // 120s - scraping pode demorar até 60s
});

export default api;
