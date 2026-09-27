// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Relative base so the build works on Vercel, on a LAN IP, or from a subpath.
  base: '/',
  // 100% client-rendered experience: everything lives in localStorage.
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    inlineStylesheets: 'auto',
  },
  vite: {
    plugins: [tailwindcss()],
    envPrefix: ['VITE_', 'PUBLIC_'],
    build: {
      // Keep the JS payload tiny for kiosk TVs.
      assetsInlineLimit: 8192,
      cssMinify: true,
    },
  },
});
