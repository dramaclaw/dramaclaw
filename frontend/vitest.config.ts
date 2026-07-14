// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // Mirror the compile-time `__APP_VERSION__` that `vite.config.ts` injects,
  // so code importing `@/lib/app-version` works under vitest too. In tests we
  // don't care about the real value — a stable placeholder is plenty.
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_ID__: JSON.stringify("test-build"),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    globals: true,
    // Don't re-collect tests from nested git worktrees. Claude Code's agent
    // lifecycle leaves locked .claude/worktrees/* directories that mirror the
    // repo; without this exclude, vitest runs every test file ~N times and
    // blows up the total count.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**", "**/.claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
