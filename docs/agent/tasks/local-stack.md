# 命令行 CE 本地栈：local_gateway + 本地 ComfyUI 图像

**状态**：执行中
**最后更新**：2026-09-18
**基线**：`38484897`；本地未提交；`nanobanana_grid.py` 同时被 `origin/main` 修改
**相关文档**：`启动说明.md`（仓库根目录，机器专属）
**相关分支 / PR**：无，工作区未提交

## 目标

不用 Docker 就能在一台开发机上跑起完整 CE：文本 / embedding / 音频走硅基流动，
图像走本机 ComfyUI（Qwen-Image / Krea 2 Turbo Int8），配置与密钥放在一个升级不会覆盖的目录里。

## 非目标

- 不把这套本机路由升级成面向所有 provider 的通用代理。
- 不把作者机器的安装路径、密钥或工作流运行态提交进公开仓库。
- 不在本线改动标准 Docker 部署路径。

## 写入边界（既有改动归属）

| 文件 | 新增/修改 | 作用 |
|---|---|---|
| `src/novelvideo/local_gateway.py` | 新增 | 本地 OpenAI 兼容路由，自己决定 provider |
| `scripts/start-local-stack.sh` | 新增 | 一键起栈，含 ComfyUI 拉起与等待 |
| `config/local/*.json` | 新增 | ComfyUI 工作流（qwen_image_t2i / krea2_turbo_t2i / krea2_turbo_edit / community 两份） |
| `src/novelvideo/config.py` | 修改 | 加 `LOCAL_QWEN_IMAGE_MODEL` / `LOCAL_KREA_IMAGE_MODEL` 两个选择项，`DRAMACLAW_LOCAL_MODELS_ONLY=1` 时只露本地两项 |
| `src/novelvideo/generators/nanobanana_grid.py` | 修改 | 回环地址（127.0.0.1/::1/localhost）绕开桌面代理设置 |
| `scripts/start-ce.sh`、`frontend/vite.config.ts` | 修改 | |
| `tests/test_local_gateway.py` | 新增 | |
| `tests/test_freezone_image_backend.py`、`test_newapi_image_gateway.py`、`test_image_generation_selection.py` | 修改 | |

`local_gateway.py`、`start-local-stack.sh`、本地工作流模板与 `test_local_gateway.py` 可视为本线独占；
`config.py`、`nanobanana_grid.py`、`start-ce.sh`、`vite.config.ts` 是共享基础设施文件。

## 协调与冲突

- `src/novelvideo/generators/nanobanana_grid.py` 同时被 `origin/main` 修改。必须先看上游修复语义，
  再把“回环地址绕代理”移植到新基线，不能提交旧文件整段。
- `config/local/` 当前整个目录未跟踪，需逐项确认哪些是可公开、可复现的模板，哪些含机器参数或运行态。
- `启动说明.md` 与脚本都含机器专属绝对路径；替换时要用本地变量文件示例，不得把真实路径搬进台账。

## 实施方案（后续）

1. 清点 `config/local/`，分离可提交模板与本机私有配置，做一次敏感信息扫描。
2. 将 ComfyUI / 仓库绝对路径改为环境变量或 `.dramaclaw-local/` 本地配置，并写无机器路径的启动步骤。
3. 在 `origin/main` 新版 `nanobanana_grid.py` 上重放最小的回环代理改动，跑相关三份测试。
4. 用一台无作者路径假设的环境按说明启动，记录健康检查结果。

## 风险与回退

- 风险是误提交模型路径 / 密钥，或覆盖上游生成器并发 / 输出路径修复。
- 回退按网关、启动脚本、生成器适配三个独立提交进行；本机私有目录不纳入 Git 回退。

## 进展记录

### 2026-09-18 · 补齐基础设施边界与机器 scope

做了什么：只更新台账和 scope，区分本线独占的 gateway / launcher / workflow 与共享的配置、生成器和启动文件；
没有修改本地栈业务代码或私有配置。

为什么这么做：基础设施文件很容易被相邻任务顺手覆盖，机器 scope 必须在继续可移植性改造前先建立。

怎么验证的：待全局 `agent_guard check` 通过；本轮没有重跑本地栈。

## 已定下来的决策（不要回头改）

- **路由自己拥有 provider 选择权**，不做成可配置的通用代理。硅基流动管文本/embedding/音频，
  本机 ComfyUI 管 Qwen Image，写死在代码里。
- **密钥与工作流副本放在用户自管、被 gitignore 的目录**（`.dramaclaw-local/`），
  升级 DramaClaw 不会替换它们。
- **数据目录沿用已有 `./state`**（如果存在），不强制迁移。
  否则老用户切到这个 wrapper 会以为项目消失了；新装才用 `~/.local/share/dramaclaw-local`。
- **回环 HTTP 必须绕开桌面代理**。走代理会让本机 ComfyUI 请求打不通。
- **macOS 上设 `PYTORCH_ENABLE_MPS_FALLBACK=1`**：MPS 后端缺 Krea ConvRot 权重用的 int8 矩阵算子。

## 待办

- [ ] **把机器专属路径从 `启动说明.md` 里拔出来**。当前写死了作者本机的 ComfyUI 安装目录
      与仓库检出目录的绝对路径，换台机器整份说明作废。
      改成 `.dramaclaw-local/` 下的本地变量文件 + 一份通用说明。
      （`scripts/start-local-stack.sh` 里的 `COMFYUI_DIR` 默认值同样写死了绝对路径，一并处理。）
- [ ] `启动说明.md` 现在是一段裸命令，没说前置条件（要先装什么、硅基流动 key 放哪、
      怎么确认起来了）。补成能照着做的步骤。
- [ ] Krea 2 Turbo Int8 标着「Mac 实验」，实验结论没记录——能不能用、慢多少、质量如何

## 阻塞

无（ComfyUI 需手动单独起，见 `启动说明.md`，这是设计如此，不算阻塞）。

## 验收标准

- 在一台干净的机器上照 `启动说明.md` 能起起来（当前做不到，见待办第一条）。
- `uv run pytest tests/test_local_gateway.py` 全绿。
- `DRAMACLAW_LOCAL_MODELS_ONLY=1` 时设置面板里只出现本地两个图像选项。

## 交接摘要

- **最后完成到**：作者机器能跑真实内容，但安装说明和脚本不可移植。
- **下一步唯一动作**：先审计 `config/local/` 是否含私有值，再设计本地变量文件格式。
- **先读这些文件**：`local_gateway.py`、`start-local-stack.sh`、`启动说明.md`、上游生成器 diff。
- **不要动这些文件 / 决策**：不要把路由泛化；不要整文件覆盖 `nanobanana_grid.py`。
