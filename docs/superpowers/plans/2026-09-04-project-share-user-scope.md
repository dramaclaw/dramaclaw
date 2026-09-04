# 项目分享用户反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让项目分享弹窗只提交已选择的可分享用户，并清晰说明搜索与授权失败原因。

**Architecture:** 在项目查询 hook 内规范化搜索词，使请求参数和查询缓存键共享同一值；弹窗保留原始输入用于编辑。弹窗以选中的用户对象作为唯一提交来源，并在本地分类 Ky 的 HTTP 响应，配合就地空结果提示和 i18n 文案提供反馈。

**Tech Stack:** React 19、TypeScript、TanStack Query、Ky、i18next、Vitest、Testing Library。

## Global Constraints

- 仅修改 `dramaclaw` 的共享前端源码；不修改 `supertale-admin-fe` 或后端授权逻辑。
- CE 运行时继续隐藏分享入口和排除分享接口，改动仅服务拥有该能力的 EE/控制面运行时。
- 不改变现有成员配额、加载保护、角色选择、撤销成员和成功提示行为。
- 所有新增用户文案同时提供中文与英文翻译。

---

## File structure

- `frontend/src/lib/queries/projects.ts`：将用户搜索输入转换为 API 请求与缓存键使用的规范化值。
- `frontend/src/components/projects/share-project-dialog.tsx`：显示空搜索结果、要求选择下拉用户、分类分享失败响应。
- `frontend/public/locales/zh/translation.json`：提供中文反馈文案。
- `frontend/public/locales/en/translation.json`：提供对应英文反馈文案。
- `frontend/src/__tests__/lib/queries/projects.test.tsx`：锁定拼音分隔符规范化的 hook 契约。
- `frontend/src/__tests__/components/projects/share-project-dialog.test.tsx`：锁定弹窗搜索、提交门控和失败提示。

### Task 1: Normalize user-search query input

**Files:**
- Modify: `frontend/src/lib/queries/projects.ts:208-220`
- Create: `frontend/src/__tests__/lib/queries/projects.test.tsx`

**Interfaces:**
- Produces: `normalizeUserSearchQuery(query: string): string`，返回去除首尾空白和 ASCII 单引号后的值。
- Consumes: `useUserSearch(project, query)` 将规范化值用于 `queryKeys.userSearch`、`q` 参数和 `enabled` 长度判断。

- [ ] **Step 1: Write the failing normalization test**

```tsx
import { describe, expect, it } from "vitest";
import { normalizeUserSearchQuery } from "@/lib/queries/projects";

describe("normalizeUserSearchQuery", () => {
  it("removes pinyin separators while preserving the username characters", () => {
    expect(normalizeUserSearchQuery("  huang'jiao  ")).toBe("huangjiao");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir frontend test src/__tests__/lib/queries/projects.test.tsx`

Expected: FAIL because `normalizeUserSearchQuery` is not exported.

- [ ] **Step 3: Add the minimal query normalization implementation**

```ts
export function normalizeUserSearchQuery(query: string): string {
  return query.trim().replaceAll("'", "");
}

export function useUserSearch(project: string, query: string) {
  const normalizedQuery = normalizeUserSearchQuery(query);
  return useQuery({
    queryKey: queryKeys.userSearch(project, normalizedQuery),
    queryFn: ({ signal }) =>
      api.get("api/v1/users/search", {
        searchParams: { project, q: normalizedQuery },
        signal,
      }).json<OkResponse<UserSearchResult[]>>(),
    enabled: Boolean(project) && normalizedQuery.length >= 3,
  });
}
```

- [ ] **Step 4: Run the normalization test to verify it passes**

Run: `pnpm --dir frontend test src/__tests__/lib/queries/projects.test.tsx`

Expected: PASS with one test.

- [ ] **Step 5: Commit the query contract**

```bash
git add frontend/src/lib/queries/projects.ts frontend/src/__tests__/lib/queries/projects.test.tsx
git commit -m "fix: normalize project share user search"
```

### Task 2: Gate sharing on a selected user and show actionable feedback

**Files:**
- Modify: `frontend/src/components/projects/share-project-dialog.tsx:3,95-130,207-255`
- Modify: `frontend/public/locales/zh/translation.json:2057-2090`
- Modify: `frontend/public/locales/en/translation.json:2057-2090`
- Modify: `frontend/src/__tests__/components/projects/share-project-dialog.test.tsx:1-110,180-300`

**Interfaces:**
- Consumes: `useUserSearch` returns `{ data?: { data: UserSearchResult[] }, isSuccess?: boolean }`.
- Consumes: Ky `HTTPError.response` may contain FastAPI `{ detail: { code: string } }`.
- Produces: the Add button uses `selectedUser` as its only eligible principal; the dialog maps scope mismatch and 404 responses to explicit translated toast messages.

- [ ] **Step 1: Extend the dialog test doubles and write failing interaction tests**

Update the query mock so `queryMocks.searchResults` and `queryMocks.userSearchSuccess` control
the returned data. Mock `sonner` and use one pending user such as
`{ id: "u2", username: "huangjiao" }`. Add tests for all four contracts:

```tsx
it("shows a local scope hint and cannot submit when search succeeds with no users", async () => {
  queryMocks.userSearchSuccess = true;
  renderDialog();
  await userEvent.type(screen.getByPlaceholderText("搜索用户名"), "nobody");
  expect(screen.getByText("未找到可分享的用户，该用户可能不在本项目的可分享范围内")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /添加/ })).toBeDisabled();
  expect(addGrantMock).not.toHaveBeenCalled();
});

it("submits only the user chosen from the result list", async () => {
  queryMocks.searchResults = [{ id: "u2", username: "huangjiao" }];
  renderDialog();
  await userEvent.type(screen.getByPlaceholderText("搜索用户名"), "huangjiao");
  await userEvent.click(screen.getByRole("button", { name: "huangjiao" }));
  await userEvent.click(screen.getByRole("button", { name: /添加/ }));
  expect(addGrantMock).toHaveBeenCalledWith({ principal_username: "huangjiao", role: "editor" });
});

it("reports an out-of-scope user from the structured 403 code", async () => {
  addGrantMock.mockRejectedValue(httpError(403, { detail: { code: "project_share_scope_mismatch" } }));
  // select a result and submit as above
  expect(toast.error).toHaveBeenCalledWith("该用户不在本项目的可分享范围内");
});

it("reports a missing user from a 404 response", async () => {
  addGrantMock.mockRejectedValue(httpError(404, { detail: "not found" }));
  // select a result and submit as above
  expect(toast.error).toHaveBeenCalledWith("未找到该用户");
});
```

Define `httpError(status, body)` with a JSON `Response`, a matching `Request`, and Ky's
`HTTPError` constructor so the component exercises the actual response-reading path. Retain one
test rejecting with `new Error()` to assert the existing generic failure message.

- [ ] **Step 2: Run the component test to verify it fails**

Run: `pnpm --dir frontend test src/__tests__/components/projects/share-project-dialog.test.tsx`

Expected: FAIL because the empty-state copy, selected-user guard, and error classification do not exist.

- [ ] **Step 3: Implement selected-user gating and response classification**

Import `HTTPError` from `ky`. Add a small local async helper that safely reads
`error.response.clone().json()`, retrieves `detail.code` only when `detail` is an object, and
returns these exact translation keys:

```ts
if (error instanceof HTTPError && error.response.status === 403 && code === "project_share_scope_mismatch") {
  return t("project.shareDialog.toastUserOutOfScope");
}
if (error instanceof HTTPError && error.response.status === 404) {
  return t("project.shareDialog.toastUserNotFound");
}
return t("project.shareDialog.toastShareFailed");
```

In `handleAdd`, replace the query fallback with the selected user guard:

```ts
const username = selectedUser?.username;
if (!username) return;
// mutateAsync unchanged
} catch (error) {
  toast.error(await projectShareFailureMessage(error, t));
}
```

Disable the Add button when `!selectedUser` in addition to the existing pending state. When the
raw input has at least three characters, `users.isSuccess` is true, no result exists, and no user
is selected, render a compact muted-text message directly below the input using
`project.shareDialog.noShareableUser`. Keep the dropdown behavior unchanged for non-empty results.

- [ ] **Step 4: Add translated copy**

Add these keys under `project.shareDialog` in both locale files:

```json
"noShareableUser": "未找到可分享的用户，该用户可能不在本项目的可分享范围内",
"toastUserOutOfScope": "该用户不在本项目的可分享范围内",
"toastUserNotFound": "未找到该用户"
```

Use semantically equivalent English translations:

```json
"noShareableUser": "No shareable user found. This user may be outside this project's sharing scope.",
"toastUserOutOfScope": "This user is outside this project's sharing scope.",
"toastUserNotFound": "User not found"
```

- [ ] **Step 5: Run focused tests and the production frontend build**

Run:

```bash
pnpm --dir frontend test src/__tests__/lib/queries/projects.test.tsx src/__tests__/components/projects/share-project-dialog.test.tsx
pnpm --dir frontend build
pnpm --dir frontend build:ce
```

Expected: all targeted tests pass; TypeScript and both Vite builds finish with exit code 0. The CE
build validates that the unchanged edition gate still compiles.

- [ ] **Step 6: Commit the UI fix**

```bash
git add frontend/src/components/projects/share-project-dialog.tsx \
  frontend/public/locales/zh/translation.json \
  frontend/public/locales/en/translation.json \
  frontend/src/__tests__/components/projects/share-project-dialog.test.tsx
git commit -m "fix: clarify project share user failures"
```
