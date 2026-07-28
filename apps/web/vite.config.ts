import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../../', '')
  const target = env.VITE_SERVER_TARGET || 'http://localhost:3001'

  return {
    plugins: [vue()],
    server: {
      host: '0.0.0.0',
      port: 5188,
      strictPort: true,
      proxy: {
        '/api': target,
        '/outputs': target,
      },
    },
  }
})
