import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server injects an inline react-refresh preamble that the production
// CSP in index.html blocks. Relax script-src for `vite dev` only; the built
// index.html keeps the strict policy.
function devCsp(): Plugin {
  return {
    name: 'haptic-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    }
  };
}

export default defineConfig({
  // Electron loads the packaged renderer over file://, so assets must be relative.
  base: './',
  plugins: [react(), devCsp()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
