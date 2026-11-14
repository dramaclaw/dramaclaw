// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  publicDir: false,
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  ssr: { noExternal: true },
  build: {
    target: 'node22',
    ssr: 'src/features/canvas/server/worker.ts',
    outDir: 'dist-canvas-server',
    emptyOutDir: true,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'canvas-core-worker.mjs', inlineDynamicImports: true },
    },
  },
});
