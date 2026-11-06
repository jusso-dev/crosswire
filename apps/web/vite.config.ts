import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  // Read .env from the repo root (one .env for dev server, CLIs and Compose).
  envDir: '../..',
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
  plugins: [tanstackStart(), viteReact()],
})
