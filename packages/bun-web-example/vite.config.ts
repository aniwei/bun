import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const sabHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  server: {
    headers: sabHeaders,
  },
  preview: {
    headers: sabHeaders,
  },
})