// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { execSync } from "node:child_process";
import path from "path";

// YYMMDD build-date prefix (UTC), e.g. "260420-". Prepended to every
// version string so "what shipped when" is readable at a glance without
// having to cross-reference the tag against a release log.
function datePrefix(d: Date = new Date()): string {
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}-`;
}

// The human-facing version, shown in the status bar. It is display-only —
// never compare it across deploys (two builds can legitimately carry the same
// version string), that's what BUILD_ID below is for.
// Resolution order:
//   1. VITE_APP_VERSION — set by release CI from the tag.
//   2. the nearest git tag (`git describe --tags --abbrev=0`) — so a local
//      checkout shows the SAME version the release stamped, automatically,
//      once you pull the code that carries the new tag. No manual bump needed.
//   3. DEFAULT_APP_VERSION — last resort for a git-less build (source tarball).
const DEFAULT_APP_VERSION = "v1.1.0";

function resolveAppVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    const tag = execSync("git describe --tags --abbrev=0", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (tag) return tag;
  } catch {
    // not a git checkout, or no tags — fall through to the constant
  }
  return DEFAULT_APP_VERSION;
}

// The deploy fingerprint. MUST differ between any two builds, because the
// running app compares it against the deployed /version.json to decide whether
// to nudge the user to refresh (see lib/version-update-watch.ts). Prefer
// `git describe`, and fall back to the build timestamp so even a git-less
// build still produces a value that changes — a constant here would silently
// disable update detection.
function resolveBuildId(): string {
  try {
    const described = execSync("git describe --tags --always --dirty", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (described) return `${datePrefix()}${described}`;
  } catch {
    // not a git checkout (e.g. source tarball) — fall through to the timestamp
  }
  return `${datePrefix()}${Date.now()}`;
}

const APP_VERSION = resolveAppVersion();
const BUILD_ID = resolveBuildId();
const DEFAULT_API_TARGET = "http://127.0.0.1:8780";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_URL || DEFAULT_API_TARGET;

  return {
    plugins: [
      TanStackRouterVite(),
      react(),
      tailwindcss(),
      {
        // Emit a tiny manifest the running app polls to detect deploys. The
        // buildId written here is the SAME compile-time constant baked into the
        // bundle via `define` below, so the running code can compare its own
        // BUILD_ID against the deployed version.json — no fetched baseline,
        // hence no seed race. `version` rides along for display/debugging only.
        name: "emit-version-json",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "version.json",
            source: JSON.stringify({ version: APP_VERSION, buildId: BUILD_ID }),
          });
        },
      },
    ],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BUILD_ID__: JSON.stringify(BUILD_ID),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    // Split heavy shared deps out of the main chunk so the initial payload is
    // mostly app code; vendor bundles cache across deploys.
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("@tanstack")) return "tanstack";
            if (id.includes("@base-ui")) return "baseui";
            if (id.includes("react-hook-form") || id.includes("@hookform") || id.includes("/zod/")) return "forms";
            if (id.includes("i18next") || id.includes("react-i18next")) return "i18n";
            if (id.includes("lucide-react")) return "icons";
          },
        },
      },
    },
    worker: {
      format: "es",
    },
    optimizeDeps: {
      // @ffmpeg/ffmpeg 内部用 `new Worker(new URL("./worker.js", import.meta.url))`
      // 起 worker；被 esbuild 预打包后 import.meta.url 指向合并产物，worker.js
      // 404，load() 永远挂起（仅 dev 受影响，prod 走 Rollup 正常）。排除预打包。
      exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        "/api/v1": {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
          // 当 VITE_API_URL 指向 HTTPS 后端、而本地 dev server 走 HTTP 时，
          // 后端下发的会话 cookie 多半带 `Secure`（HTTPS + HSTS 部署的常态），
          // 浏览器会拒绝在非安全连接上写入它 —— 于是登录拿到 200/username 后
          // cookie 却没存住，紧接着 /auth/me 401，被守卫弹回 /login。
          // 这里在回程改写 Set-Cookie：去掉 Secure、把 SameSite=None 降为 Lax、
          // 去掉 Domain（让 cookie 落到 dev host），使 HTTP dev 也能持有会话。
          configure: (proxy) => {
            proxy.on("proxyRes", (proxyRes) => {
              const setCookie = proxyRes.headers["set-cookie"];
              if (!setCookie) return;
              proxyRes.headers["set-cookie"] = setCookie.map((cookie) =>
                cookie
                  .replace(/;\s*Secure/gi, "")
                  .replace(/;\s*SameSite=None/gi, "; SameSite=Lax")
                  .replace(/;\s*Domain=[^;]+/gi, ""),
              );
            });
          },
        },
        "/static": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
