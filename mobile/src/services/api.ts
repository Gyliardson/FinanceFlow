import axios from 'axios';

type AccessTokenProvider = () => Promise<string | null> | string | null;

let accessTokenProvider: AccessTokenProvider | null = null;

export function configureApiAccessTokenProvider(provider: AccessTokenProvider | null) {
  accessTokenProvider = provider;
}

const api = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_URL,
  timeout: 120000,
});

api.interceptors.request.use(async (config) => {
  const token = accessTokenProvider ? await accessTokenProvider() : null;

  config.headers.delete('X-API-KEY');
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  } else {
    config.headers.delete('Authorization');
  }

  return config;
});

export default api;
