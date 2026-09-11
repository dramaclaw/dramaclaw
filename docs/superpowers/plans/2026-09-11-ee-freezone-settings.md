# EE Freezone Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the settings entry in EE while keeping CE-only model and storage pages hidden.

**Architecture:** The shared Header always exposes and mounts `SettingsDialog`. Runtime-specific page visibility remains owned by `SettingsDialog`, whose existing `isCeRuntime()` guards already limit EE to Freezone Skills and prevent CE model-gateway status queries.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, pnpm

## Global Constraints

- CE must retain model/channel, media storage, and Freezone Skills settings.
- EE must expose only Freezone Skills through the shared settings dialog.
- Do not change visual tokens, layout, backend APIs, or authorization behavior.
- Follow test-driven development: observe the regression test fail before editing production code.

---

### Task 1: Restore the EE settings entry

**Files:**
- Modify: `frontend/src/components/layout/header.tsx`
- Test: `frontend/src/__tests__/components/layout/header.test.tsx`
- Verify: `frontend/src/__tests__/components/settings/settings-dialog.test.tsx`

**Interfaces:**
- Consumes: `isCeRuntime()` inside `SettingsDialog` for page/query isolation.
- Produces: a Header settings button that opens `SettingsDialog` in both CE and EE.

- [x] **Step 1: Write the failing EE Header regression test**

Mock `SettingsDialog` with a dialog rendered only when `open` is true, add the missing `header.settings` translation, render the Header with `runtimeState.isCe = false`, click the settings control, and assert that the dialog appears.

- [x] **Step 2: Run the regression test and verify RED**

Run: `pnpm exec vitest run src/__tests__/components/layout/header.test.tsx -t "keeps the settings entry available in EE runtime" --maxWorkers=1`

Expected: FAIL because the EE Header does not render a button named `header.settings`.

- [x] **Step 3: Implement the minimal Header change**

Remove the `ceRuntime` wrapper around the settings button and replace the conditionally mounted dialog with:

```tsx
<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
```

Keep `ceRuntime` for model gateway querying and warning visibility.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run src/__tests__/components/layout/header.test.tsx src/__tests__/components/settings/settings-dialog.test.tsx --maxWorkers=1`

Expected: both test files pass, including the EE Header entry and EE-only Skills page assertions.

- [x] **Step 5: Run production verification**

Run: `pnpm build`

Expected: TypeScript and Vite production build exit successfully.

- [x] **Step 6: Review and commit**

Inspect `git diff --check`, `git diff`, and `git status --short`, then commit the implementation and tests with `fix(settings): restore freezone settings in ee`.
