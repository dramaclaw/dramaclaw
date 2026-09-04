# 项目名称长度限制实施计划

> **供自动化执行者使用：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans` 按任务逐项执行。本计划以复选框追踪进度。

**目标：** 限制新建项目名称最多 64 个字符，并统一 API schema、后端校验、前端提示和测试。

**架构：** 后端在 `ProjectCreate` 和 `validate_project_name()` 各自执行 64 字符约束；前端在现有创建项目弹窗中用应用层校验显示本地化错误并禁用创建。前端不使用原生 `maxLength`，因为它会截断输入，违背已确认的交互要求。

**技术栈：** Python、FastAPI、Pydantic、pytest、React、TypeScript、i18next、Vitest。

## 全局约束

- 最大长度固定为 64 个字符。
- 合法字符仍限 `[A-Za-z0-9_]`，且不能以下划线开头。
- schema 拒绝请求时沿用 FastAPI 422；共享函数拒绝时返回 400 和 `Project name must be at most 64 characters long`。
- 过长输入必须显示错误、禁用创建且不截断用户已输入内容。
- 重名检测及响应保持不变。

---

## 文件结构

- 修改 `src/novelvideo/api/schemas.py`：声明 schema 的最大长度。
- 修改 `src/novelvideo/api/deps.py`：增加共享长度校验。
- 新建 `tests/test_project_name_validation.py`：覆盖 schema、共享函数和 HTTP 入口。
- 修改 `frontend/src/routes/_app/index.tsx`：增加前端长度校验。
- 修改 `frontend/public/locales/en/translation.json` 与 `frontend/public/locales/zh/translation.json`：加入错误文案。
- 新建 `frontend/src/__tests__/routes/project-name-validation.test.tsx`：覆盖前端边界。
- 修改 `docs/superpowers/specs/2026-09-02-project-name-length-design.md`：删除 `maxLength` 表述，改为应用层校验。

### Task 1: 后端 schema 与共享校验

**文件：** `src/novelvideo/api/schemas.py:42-43`、`src/novelvideo/api/deps.py:136-149`、`tests/test_project_name_validation.py`。

- [ ] **步骤 1：编写失败测试**

```python
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from novelvideo.api.deps import validate_project_name
from novelvideo.api.schemas import ProjectCreate

@pytest.mark.parametrize("name", ["a", "a" * 64, "project_01"])
def test_schema_accepts_valid_project_name_lengths(name):
    assert ProjectCreate(name=name).name == name

def test_schema_rejects_65_character_project_name():
    with pytest.raises(ValidationError, match="64"):
        ProjectCreate(name="a" * 65)

def test_shared_validator_rejects_65_character_project_name():
    with pytest.raises(HTTPException) as exc:
        validate_project_name("a" * 65)
    assert exc.value.status_code == 400
    assert exc.value.detail == "Project name must be at most 64 characters long"

@pytest.mark.parametrize("name", ["", "中文", "has space", "has-dash", "has/slash", "_hidden"])
def test_shared_validator_keeps_existing_format_rules(name):
    with pytest.raises(HTTPException):
        validate_project_name(name)
```

- [ ] **步骤 2：确认测试失败**

运行 `uv run pytest tests/test_project_name_validation.py -v`；预期 65 字符用例失败。

- [ ] **步骤 3：最小实现**

将模型改为：

```python
class ProjectCreate(BaseModel):
    name: str = Field(max_length=64)
```

在 `validate_project_name()` 的格式检查前添加：

```python
if len(name) > 64:
    raise HTTPException(status_code=400, detail="Project name must be at most 64 characters long")
```

- [ ] **步骤 4：验证并提交**

运行 `uv run pytest tests/test_project_name_validation.py tests/ports/test_project_local_uniqueness.py -v`；预期全部通过且重名仍为 409。随后执行 `git add src/novelvideo/api/schemas.py src/novelvideo/api/deps.py tests/test_project_name_validation.py && git commit -m "feat(api): limit project name length"`。

### Task 2: 前端提示、无截断交互和翻译

**文件：** `frontend/src/routes/_app/index.tsx:95,1170-1180,1330-1350`、两个翻译 JSON、`frontend/src/__tests__/routes/project-name-validation.test.tsx`。

- [ ] **步骤 1：编写失败的前端单元测试**

在路由模块导出 `PROJECT_NAME_MAX_LENGTH` 和 `getProjectNameValidationKey()`，测试写为：

```tsx
import { describe, expect, it } from "vitest";
import { PROJECT_NAME_MAX_LENGTH, getProjectNameValidationKey } from "@/routes/_app/index";

describe("项目名称长度校验", () => {
  it("接受 64 字符名称", () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(64);
    expect(getProjectNameValidationKey("a".repeat(64))).toBeNull();
  });
  it("拒绝 65 字符名称", () => {
    expect(getProjectNameValidationKey("a".repeat(65))).toBe("project.nameTooLong");
  });
});
```

- [ ] **步骤 2：确认测试失败**

运行 `cd frontend && npm test -- project-name-validation.test.tsx`；预期因导出不存在而失败。

- [ ] **步骤 3：最小实现与文案**

在 `PROJECT_NAME_PATTERN` 后添加：

```tsx
export const PROJECT_NAME_MAX_LENGTH = 64;
export function getProjectNameValidationKey(name: string): string | null {
  if (name.length > PROJECT_NAME_MAX_LENGTH) return "project.nameTooLong";
  return !PROJECT_NAME_PATTERN.test(name) ? "project.nameInvalid" : null;
}
```

令 `createNameError` 先根据 `getProjectNameValidationKey(trimmedNewName)` 取得翻译，再执行现有三种重名分支；不得为 `<Input>` 添加 `maxLength`。在 `project` 翻译节点增加 `nameTooLong`：英文为 `Project name must be at most 64 characters long.`，中文为 `项目名称最多 64 个字符`。

- [ ] **步骤 4：验证并提交**

运行 `cd frontend && npm test -- project-name-validation.test.tsx locales-json.test.ts && npm run build`；预期测试和构建均通过。随后执行 `git add frontend/src/routes/_app/index.tsx frontend/public/locales/en/translation.json frontend/public/locales/zh/translation.json frontend/src/__tests__/routes/project-name-validation.test.tsx && git commit -m "feat(ui): validate project name length"`。

### Task 3: HTTP 契约与最终验证

**文件：** `tests/contract/test_m02_projects.py:73-76`、`docs/superpowers/specs/2026-09-02-project-name-length-design.md`。

- [ ] **步骤 1：增加 HTTP 422 契约测试**

在 `tests/contract/test_m02_projects.py` 中现有 `with TestClient(app) as client:` 代码块内，紧接成功创建断言后调用 `client.post("/api/v1/projects", json={"name": "a" * 65})`，断言 `status_code == 422` 且响应中包含 `64`；不得用直接调用函数代替路由测试。

- [ ] **步骤 2：同步设计说明**

将 spec 中“为输入框增加 `maxLength`”改为“应用层长度校验；不截断输入”，使其和已确认的交互一致。

- [ ] **步骤 3：执行完整验证并提交**

运行 `uv run pytest` 和 `cd frontend && npm run build`；预期均成功。最后执行 `git add tests/contract/test_m02_projects.py docs/superpowers/specs/2026-09-02-project-name-length-design.md && git commit -m "test: cover project name length boundaries"`。
