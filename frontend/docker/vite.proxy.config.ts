import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    outDir: "docker-dist",
    emptyOutDir: true,
    copyPublicDir: false,
    lib: {
      entry: "docker/org-brand-proxy-main.ts",
      formats: ["es"],
      fileName: () => "org-brand-proxy-server.mjs",
    },
    rollupOptions: {
      external: [/^node:/],
    },
  },
});
