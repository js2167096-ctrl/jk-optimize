import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') }

// CSP aplicada no HTML apenas no build de produção. Em desenvolvimento o
// processo principal injeta a política via cabeçalho (o Vite precisa de HMR).
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function productionCsp(): Plugin {
  return {
    name: 'jk-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'executor-worker': resolve(__dirname, 'src/main/executor/worker.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  // Raiz relativa: caminhos absolutos quebram o build quando a pasta do projeto
  // está em um diretório redirecionado pelo Windows (ex.: AppData virtualizado).
  // A entrada padrão é src/renderer/index.html.
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { ...sharedAlias, '@renderer': resolve(__dirname, 'src/renderer') },
      preserveSymlinks: true
    },
    plugins: [react(), tailwindcss(), productionCsp()],
    build: { minify: true }
  }
})
