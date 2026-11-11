import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/, https://vite.dev/guide/env-and-mode, https://stackoverflow.com/questions/66389043/how-can-i-use-vite-env-variables-in-vite-config-js
export default defineConfig({
  plugins: [react()],
  server: 
  {
    proxy: // https://vite.dev/config/server-options
    {
      '/api': 
      {
        target: env.VITE_API_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
