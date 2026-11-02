// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

// 5173 / 5174 留给日常开发的 dev server，冒烟测试自己起一个。
const PORT = 5199;

export default defineConfig({
  testDir: ".",
  // 不叫 *.spec.ts / *.test.ts：那两个名字会被 vitest 一并收走。
  testMatch: "*.e2e.ts",
  outputDir: "./test-results",
  reporter: "list",
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // 用本机装的 Chrome，不用 Playwright 自带的 Chromium：后者不带 H.264 编码器，
    // 逐帧出片那条路在它上面走不通，测到的只会是实时录制的回退。
    channel: "chrome",
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort --host 127.0.0.1`,
    // 默认在本配置所在目录起命令；vite 的配置和 `src` 在上一层。
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    url: `http://127.0.0.1:${PORT}/e2e/previz.html`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
