import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { existsSync, readFileSync } from 'node:fs'
import { lanDiagnostics } from './scripts/lan-diagnostics.ts'

// Local certificate made by `npm run cert` (trusted on iPhone after installing .cert/ca.crt).
// Falls back to an untrusted throwaway certificate when it doesn't exist.
const hasLocalCert = existsSync('.cert/server.crt') && existsSync('.cert/server.key')
const localHttps = hasLocalCert ? { cert: readFileSync('.cert/server.crt'), key: readFileSync('.cert/server.key') } : undefined

/**
 * Content-Security-Policy for production builds: the browser itself refuses any network
 * connection outside the app's own origin, so financial data cannot be sent anywhere —
 * even by a bug or a dependency default (e.g. Tesseract's CDN fallback).
 * 'wasm-unsafe-eval'/'unsafe-eval' are needed for the OCR WebAssembly engine on iOS Safari.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

const cspPlugin = (): Plugin => ({
  name: 'finance-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
})

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves a project site from /<repo>/ — the deploy workflow sets BASE_PATH.
  // Locally it stays "/".
  base: process.env.BASE_PATH || '/',
  // shown in Settings so you can see which version is installed after an update
  define: { __APP_VERSION__: JSON.stringify(`${process.env.npm_package_version ?? '0'} · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`) },
  // transpile JS syntax down to what iOS 15 Safari understands
  build: { target: ['es2020', 'safari15', 'ios15'] },
  ...(mode === 'https' && localHttps ? { server: { https: localHttps }, preview: { https: localHttps } } : {}),
  plugins: [
    // `npm run iphone` — HTTPS over Wi-Fi so the camera works on iPhone
    ...(mode === 'https' ? [...(localHttps ? [] : [basicSsl()]), lanDiagnostics()] : []),
    // `--mode lan-http`: same diagnostics over plain HTTP, to tell network problems from certificate problems
    ...(mode === 'lan-http' ? [lanDiagnostics()] : []),
    cspPlugin(),
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt': a new version waits until the user taps «Обновить» — never reloads mid-entry.
      // Updating only swaps app files; IndexedDB data is untouched.
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Finance',
        short_name: 'Finance',
        description: 'Личный финансовый трекер',
        lang: 'ru',
        theme_color: '#06070D',
        background_color: '#06070D',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // app shell + fonts + OCR worker/WASM/language data → everything works offline after first load
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm,gz}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/__/],
      },
    }),
  ],
}))
