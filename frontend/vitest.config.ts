// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { storyPlayerPlugin } from './build/storyPlayerPlugin';
import { defineConfig } from "vitest/config";
import path from "path";

// These tests use Node APIs only; keep browser fixtures out of their workers.
const nodeTests = [
  "src/__tests__/components/credit-promotion-coverage.test.ts",
  "src/__tests__/components/login/announcement-dialog-layout-contract.test.ts",
  "src/__tests__/components/login/login-modal-layout-contract.test.ts",
  "src/__tests__/components/login/popover-backdrop-contract.test.ts",
  "src/__tests__/deployment/org-brand-assets.test.ts",
  "src/__tests__/deployment/payment-form-csp.test.ts",
  "src/__tests__/features/canvas/audio-node-credit-contract.test.ts",
  "src/__tests__/features/canvas/image-gen-director-world-entry.test.ts",
  "src/__tests__/features/canvas/image-reverse-prompt-credit-contract.test.ts",
  "src/__tests__/features/canvas/image-tool-feature-billing-contract.test.ts",
  "src/__tests__/features/canvas/node-selection-contract.test.ts",
  "src/__tests__/features/canvas/script-node-credit-contract.test.ts",
  "src/__tests__/features/canvas/text-generate-credit-contract.test.ts",
  "src/__tests__/features/canvas/video-breakdown-credit-contract.test.ts",
  "src/__tests__/features/companion/pet-gallery-groups-contract.test.ts",
  "src/__tests__/features/freezone/canvas-agent-single-session-contract.test.ts",
  "src/__tests__/features/freezone/chat-launcher-contract.test.ts",
  "src/__tests__/features/freezone/workflow-node-action-contract.test.ts",
  "src/__tests__/features/piko-mini-game-design-contract.test.ts",
  "src/__tests__/features/piko-mini-game-library-contract.test.ts",
  "src/__tests__/i18n/locales-json.test.ts",
  "src/__tests__/lib/upload-timeout-contract.test.ts",
  "src/__tests__/routes/audio-indextts2-contract.test.ts",
  "src/__tests__/routes/beats-main-ui-contract.test.ts",
  "src/__tests__/routes/beats-sketch-render-contract.test.ts",
  "src/__tests__/routes/characters-indextts-cutover.test.ts",
  "src/__tests__/routes/compose-export-contract.test.ts",
  "src/__tests__/routes/episodes-beats-sub-integration.test.ts",
  "src/__tests__/routes/episodes-workbench-integration.test.ts",
  "src/__tests__/routes/ingest-credit-cost-contract.test.ts",
  "src/__tests__/routes/script-source-editor-integration.test.ts",
  "src/__tests__/routes/script-workflow-contract.test.ts",
  "src/__tests__/routes/seedance2-minimal-config-contract.test.ts",
  "src/__tests__/routes/selected-video-task-contract.test.ts",
  "src/__tests__/routes/styles-credit-cost-contract.test.ts",
  "src/__tests__/routes/video-backend-options-contract.test.ts",
  "src/__tests__/theme-bootstrap.test.ts",
  "src/features/piko-world/piko-ui-assets.test.ts",
];

const excludedTests = ["**/node_modules/**", "**/dist/**", "**/.worktrees/**", "**/.claude/**"];

export default defineConfig({
  plugins: [storyPlayerPlugin()],
  // Mirror the compile-time `__APP_VERSION__` that `vite.config.ts` injects,
  // so code importing `@/lib/app-version` works under vitest too. In tests we
  // don't care about the real value — a stable placeholder is plenty.
  define: {
    __APP_VERSION__: JSON.stringify("test"),
    __BUILD_ID__: JSON.stringify("test-build"),
  },
  test: {
    globals: true,
    // Don't re-collect tests from nested git worktrees. Claude Code's agent
    // lifecycle leaves locked .claude/worktrees/* directories that mirror the
    // repo; without this exclude, vitest runs every test file ~N times and
    // blows up the total count.
    exclude: excludedTests,
    projects: [
      { extends: true, test: { name: "node", environment: "node", include: nodeTests } },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./src/__tests__/setup.ts"],
          exclude: [...excludedTests, ...nodeTests],
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
