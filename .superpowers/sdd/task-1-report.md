# Task 1 Report

Date: 2026-09-04

## Scope

Implemented Task 1 only: normalize project-share user search input in the frontend query layer.

## RED

Command:

```bash
pnpm --dir frontend test src/__tests__/lib/queries/projects.test.tsx
```

Exit code: 1

Output:

```text
$ vitest run src/__tests__/lib/queries/projects.test.tsx

 RUN  v4.1.6 /Users/wwq/worknewnew/dramaclaw-codex-fix-project-share-user-scope/frontend

(node:74757) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)
 ❯ src/__tests__/lib/queries/projects.test.tsx (1 test | 1 failed) 4ms
     × removes pinyin separators while preserving the username characters 1ms

 FAIL  src/__tests__/lib/queries/projects.test.tsx > normalizeUserSearchQuery > removes pinyin separators while preserving the username characters
TypeError: normalizeUserSearchQuery is not a function
 ❯ src/__tests__/lib/queries/projects.test.tsx:7:12
      5| describe("normalizeUserSearchQuery", () => {
      6|   it("removes pinyin separators while preserving the username characte…
      7|     expect(normalizeUserSearchQuery("  huang'jiao  ")).toBe("huangjiao…
       |            ^
      8|   });
      9| });

 Test Files  1 failed (1)
      Tests  1 failed (1)
   Duration  1.52s

[ELIFECYCLE] Test failed. See above for more details.
```

## GREEN

Command:

```bash
pnpm --dir frontend test src/__tests__/lib/queries/projects.test.tsx
```

Exit code: 0

Output:

```text
$ vitest run src/__tests__/lib/queries/projects.test.tsx

 RUN  v4.1.6 /Users/wwq/worknewnew/dramaclaw-codex-fix-project-share-user-scope/frontend

(node:74796) Warning: `--localstorage-file` was provided without a valid path
(Use `node --trace-warnings ...` to show where the warning was created)

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  848ms
```

## Changes

- `frontend/src/__tests__/lib/queries/projects.test.tsx`
- `frontend/src/lib/queries/projects.ts`

## Implementation Notes

- Added `normalizeUserSearchQuery(query: string): string`.
- Normalization trims surrounding whitespace and removes ASCII apostrophes.
- `useUserSearch` now uses the normalized value for `queryKeys.userSearch`, request `q`, and `enabled`.

## Self-Review

- Scope stayed within Task 1 files only.
- Implementation matches the task brief exactly.
- No additional behavior or refactors were introduced.

## Verification

- Targeted vitest regression passes.
- No broader frontend suite was run for this task.

## Commit

- `1d4cdcac` `fix: normalize project share user search`

## Repository Note

- `.superpowers/sdd/task-1-report.md` is ignored by default in this repo, so it was added with `git add -f` to satisfy the task requirement.

## Concerns

- The test run emits an existing Vitest/localstorage warning unrelated to this change.

---

## 2026-09-04 Compatibility Follow-up

### Scope

- Fixed the frontend build compatibility issue in `frontend/src/lib/queries/projects.ts` only.
- Kept the existing project-share dialog behavior, translations, and test semantics unchanged.

### Root Cause

- `normalizeUserSearchQuery` used `String.prototype.replaceAll("'", "")`.
- The current frontend TypeScript lib target does not include `replaceAll`, so both `pnpm --dir frontend build` and `pnpm --dir frontend build:ce` failed during `tsc -b`.

### RED

Command:

```bash
pnpm --dir frontend build
```

Exit code: `2`

Output excerpt:

```text
src/lib/queries/projects.ts(209,23): error TS2550: Property 'replaceAll' does not exist on type 'string'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2021' or later.
[ELIFECYCLE] Command failed with exit code 2.
```

### Change

- Replaced `query.trim().replaceAll("'", "")` with the behavior-equivalent, lib-compatible `query.trim().replace(/'/g, "")`.

### GREEN

Commands:

```bash
pnpm --dir frontend test src/__tests__/lib/queries/projects.test.tsx src/__tests__/components/projects/share-project-dialog.test.tsx
pnpm --dir frontend build
pnpm --dir frontend build:ce
```

Exit codes: all `0`

Results:

- Vitest: `2` files passed, `15` tests passed.
- `frontend` production build completed successfully.
- `frontend` CE build completed successfully.

### Self-Review

- The change is minimal and limited to the compatibility fault.
- Apostrophe stripping behavior is preserved exactly for user search normalization.
- Remaining build output only contains pre-existing Vite chunk-size / dynamic-import warnings unrelated to this fix.
