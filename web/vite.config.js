import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/, https://vite.dev/guide/env-and-mode, https://stackoverflow.com/questions/66389043/how-can-i-use-vite-env-variables-in-vite-config-js
export default defineConfig({mode}) =>
{
  const env = loadEnv(mode, process.cwd(), '');
  return {
  plugins: [react()],
  server: 
  {
    proxy: // https://vite.dev/config/server-options
    {
      '/api': 
      {
        target: env.VITE_API_URL || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
},
};
