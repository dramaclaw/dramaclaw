# 中文项目名称与拼音目录

**状态**：待验收
**最后更新**：2026-09-27
**基线**：`60c22be`；`codex/sync-main-remotes` 与同名 origin 分支同步；业务工作区初始干净。
**认领者**：`codex/project-names-push-20260927`
**相关文档**：无
**相关分支 / PR**：无

## 目标
新建和重命名支持中文、空格与标题标点；新目录使用无声调拼音且碰撞加序号。LibTV 新导入预填原名，已有导入可选原名并查看来源链接；重命名只更新显示名，项目 ID 与持久化路径不变。

## 非目标
不迁移或重命名旧目录，不改画布、模型或本地工作流 JSON；提交/推送按用户最新明确授权执行。

## 现状与证据
- 前端与 API 使用 ASCII 正则，CE registry 默认把 name 作为目录；ProjectRecord 已独立持久化三个路径，ProjectContext、项目列表和画布任务使用这些路径。
- pypinyin 已为直接依赖，无需安装；更新项目风格的 labels 调用未传 state_dir，需补齐避免中文名称重新构造旧路径。
- 目标文件无未提交 diff；origin/main 与 HEAD 的名称限制一致，三方差异只有首页导入缓存及 API 本地路由修复，保留已有实现。当前同名远端已合入 HEAD，无第二份中文命名实现。

## 写入边界
| 路径 | 模式 | 作用 |
|---|---|---|
| `src/novelvideo/api/deps.py` | 独占 | 中文命名、拼音目录与路径一致性 |
| `src/novelvideo/ports/local/project.py` | 独占 | 中文命名、拼音目录与路径一致性 |
| `src/novelvideo/shared/project_dirs.py` | 独占 | 中文命名、拼音目录与路径一致性 |
| `src/novelvideo/api/routes/projects.py` | 独占 | 中文命名、拼音目录与路径一致性 |
| `src/novelvideo/services/style_service.py` | 独占 | 中文命名、拼音目录与路径一致性 |
| `frontend/src/routes/_app/index.tsx` | 共享 | 中文命名、拼音目录与路径一致性 |
| `frontend/public/locales/zh/translation.json` | 共享 | 中文命名、拼音目录与路径一致性 |
| `frontend/public/locales/en/translation.json` | 共享 | 中文命名、拼音目录与路径一致性 |
| `frontend/public/locales/vi/translation.json` | 共享 | 中文命名、拼音目录与路径一致性 |
| `tests/test_project_name_validation.py` | 独占 | 中文命名、拼音目录与路径一致性 |

| `tests/ports/test_project_chinese_names.py` | 独占 | 用户授权命名与创建回归 |

| `frontend/src/__tests__/routes/project-name-validation.test.tsx` | 独占 | 用户授权命名与创建回归 |

| `frontend/src/__tests__/routes/project-chinese-names.test.tsx` | 独占 | 用户授权命名与创建回归 |

| `src/novelvideo/ports/project.py` | 独占 | 项目重命名与来源信息 |
| `src/novelvideo/api/schemas.py` | 共享 | 项目重命名与来源信息 |
| `frontend/src/lib/project-naming.ts` | 独占 | 项目重命名与来源信息 |
| `frontend/src/components/projects/project-name-dialog.tsx` | 独占 | 项目重命名与来源信息 |
| `frontend/src/features/freezone/createProjectLiblibImport.ts` | 共享 | 项目重命名与来源信息 |
| `frontend/src/features/freezone/CanvasesTab.tsx` | 共享 | 项目重命名与来源信息 |
| `frontend/src/__tests__/routes/project-first-liblib-import.test.tsx` | 共享 | 项目重命名与来源信息 |
| `tests/test_project_rename.py` | 独占 | 项目重命名与来源信息 |

协调元数据见 claim 精确列表；不触碰本地凭据、数据和生成文件。

## 协调与冲突
- 首页与 liblib-first-import / liblib-canvas-parity / legacy-unassigned-diff 串行共享，仅修改名称校验；历史差异均已提交。
- 三语字典按键合并，保留 Director/H3 和其他工作线所有文案；显式共享 peer 已双边登记，通用字典 claims 按既有 * 协议共享。
- 本线为最终集成者，修改前 acquire + preflight；不覆盖其他工作区或远端代码。

## 实施方案
### 2026-09-27 · 用户批准重命名与 LibTV 原名方案
1. 放宽显示名称，支持中文、空格、连字符、书名号与 Unicode 标题，保持 64 字符、禁止空白名称和路径/控制字符。新目录仍仅生成安全 ASCII 拼音。
2. Registry 增加按 ID 修改 name 的原子方法；POST 项目 rename 限 owner，复用唯一名称约束并返回 409，保留三个目录和 ID；跨发行未实现端口返回明确 501。
3. 全局 projects/liblib-preview 在创建项目前读取可复制分享的原名称和标准化 URL；复用现有 Cookie 与远端接口，不本地化素材。失败展示可重试提示，允许手动填名。
4. 首页卡片/列表菜单增加重命名、使用 Liblib 原名和项目来源；弹窗复用现有 UI token，按需读画布元数据，多来源逐项选择，外链只接受校验后的 LibTV URL。保存后刷新项目列表与项目配置缓存。
5. 新建粘贴链接时预读原名，用户编辑过名称后不自动覆盖；快速换链接/关闭弹窗取消旧请求结果。原名保存在 liblib_import.source_name，老画布回退 display_name；两个导入入口均保存。已有项目不批量改名。
6. 沿用已获授权补充命名/重命名/路径稳定性及界面回归；检查类型与 i18n，必要时按已有授权重启。真实数据只读，临时验收数据单独清理。

风险与回退补充：远端登录或网络失败不能阻止手动命名；仅 owner 改名，重名保持旧名。新增接口与界面按本线 diff 回退，不改旧目录。原有 28 个脏文件均属于本线前序改动；本轮相关 origin/main 无同类重命名实现，复用已有详情/导入链，不引入数据库迁移。

### 2026-09-27 · 用户追加测试授权
用户明确要求“测试看看”。在原实现上补充中文前后端校验、拼音/同音/大小写/截断/既有目录/并发注册与旧记录回读回归，运行相关既有测试。新增独立前端创建组件测试（模拟 API 并确认中文名原样提交）。通过当前服务创建两条本轮唯一前缀临时项目，检查保存/读取/归档/恢复，结束只清理本轮新建的项目与目录；不触碰用户既有项目。只做本地操作，不请求模型生成。

1. 前后端一致接受中文、英文字母、数字、下划线，保留 64 字符与禁下划线开头规则，调整三语错误提示。仅移除既有测试中已过时的中文拒绝断言，不新增或运行测试。
2. 新目录基名使用 pypinyin、ASCII 清理与长度上限，Windows 保留名加安全前缀。目录分配在 SQLite 写事务内比对注册路径及磁盘占用，冲突加序号；显式路径覆盖保持兼容。
3. 只在创建时分配，后续读取持久化路径；风格标签读取补 state_dir。
4. 运行静态检查 / 类型检查，记录人工验收未执行；按既有授权重启受影响 API，保留生成服务。

## 风险与回退
- 多音字使用词库默认读音；同音项目必须独立目录。事务保证本注册器并发分配不复用路径，磁盘既有目录也不覆盖。
- 旧项目无需迁移；回退仅本线代码块，已创建项目可继续通过 ID 和保存路径读取，不删除目录或数据。

## 验收标准
- [x] 前后端中文规则一致，三语提示同步。
- [x] 新建显示名保持原文，拼音目录冲突可区分；旧目录保持原路径（代码审查）。
- [x] Python lint / TypeScript / diff / guard 静态检查通过。
- [x] 授权实测临时中文项目：创建、配置读取、画布保存/重读、归档/恢复、隔离及清理全部通过；前端创建弹窗组件通过。
- [x] 写入范围可解释，交接台账齐备。
- [x] 重命名、LibTV 原名预读/选择、来源链接通过组件与真实 API 回归。
- [ ] 用户刷新页面验收新增菜单与弹窗。

## 进展记录

### 2026-09-29 · 公开 origin 集成共享路径协调

本线既有已提交实现先于 `sync-main-remotes`；后者在独立 `codex/public-origin-sync` 检出中作为唯一后序集成者，仅对同名 claim 互认的精确路径解决公开上游三方冲突。本线旧产品合同、验证结果和业务所有权不因协调改写；最终合并验证与公开 PR 交付由同步线记录。
### 2026-09-27 · 提交前审计通过
- 精确暂存 48 个文件，均属于本工作线业务、已有回归或必要协调记录；与 claims 逐项核对一致，未暂存本地工作流、凭据、Cookie、运行配置或生成数据。
- 暂存差异 `git diff --cached --check` 通过；agent guard（31 条工作线 / 1027 claims）和违禁词检查通过；Gitleaks 8.30.1 按仓库 pre-commit 配置扫描约 79KB 差异，无密钥泄露。
- 本轮仅建立提交并推送现有实现，未运行新增实现测试、未发模型请求。此前 132 项回归与真实 API 证据仍见下文；使用原 Git 身份、Signed-off-by 和普通同名分支推送，最终提交与远端状态以 Git 为准。

### 2026-09-27 · 用户授权提交并推送
- 用户明确要求“提交代码并 push”，本轮只提交此前已实现的中文显示名、拼音目录、重命名、LibTV 原名预读/选择/来源入口、相关回归及必要协调文档；不追加 H3 图片数量改动。
- HEAD 与目标 origin/codex/sync-main-remotes 均为 60c22be。48 个工作区差异均归本线已有精确 claims；暂存区初始为空，无新增外来业务修改。原本“不提交/推送”的非目标由本次授权替代。
- 按 claim 精确清单逐文件暂存，确认本地工作流、凭据、Cookie、运行配置和生成数据不进入提交；执行暂存 diff、guard、违禁词与脱敏密钥扫描，使用既有身份和 Signed-off-by 创建提交。
- 使用代理正常推送当前分支到 origin 同名分支，随后读取远端 SHA 确认；不 force、不 rebase、不修改其他远端分支。若远端提前前进，重新审计差异再处理。
- 实现验证沿用前轮 99 项后端、33 项前端、类型检查、静态检查和真实 API 结果；本轮不重复运行实现测试或提交生成任务。风险为混入非目标数据，使用精确暂存清单与密钥扫描防止；回退使用具体提交 revert，不改写远端历史。

### 2026-09-27 · 中文重命名与 LibTV 原名闭环
- 用户“按建议修改”批准方案，取得 `codex/project-rename-20260927` 锁并完成全部精确路径 preflight。复用旧导入元数据，不做数据库迁移，不批量改名已有项目。
- 新增 owner 级 POST projects/{id}/rename，SQLite 事务仅更新 name/updated_at，重名 409 并回滚；新增 POST projects/liblib-preview，用既有受限导入链在创建项目之前读取原名。
- 项目卡片和列表菜单提供“重命名 / 使用 Liblib 原名 / 项目来源”；原名可编辑，多导入来源逐项选择，链接打开原项目。新建弹窗预读标题，取消时中止请求，用户手动改名优先；预读失败提供重试与手填。新增导入保存 source_name，历史画布回退 display_name。
- 名称允许中文、Unicode、空格、连字符及书名号，前后端一致禁止空白名、路径字符及控制字符，保留 64 字符及禁下划线开头。新目录 NFKC 规范化后转拼音，罗马数字转 ASCII，连续标点合并下划线；旧目录不变。
- 后端 `pytest tests/test_project_rename.py tests/test_project_name_validation.py tests/ports/test_project_chinese_names.py tests/ports/test_project_registry.py tests/ports/test_project_local_uniqueness.py tests/test_project_context.py tests/test_api_project_summary_paths.py tests/test_project_id_route_paths.py tests/test_api_styles.py tests/test_project_spine_template.py -q`：99 passed；仅既有依赖弃用提示。回归发现并修正标题标点导致双下划线的问题。
- 前端 `vitest run src/__tests__/routes/project-name-validation.test.tsx src/__tests__/routes/project-chinese-names.test.tsx src/__tests__/routes/project-first-liblib-import.test.tsx`：33 passed，含预填原名、慢请求不覆盖手填、失败回退、多个来源、重名错误和原首次导入重试。
- `tsc -b`、改动 Python 文件 ruff、前后端 i18n 棘轮、CE 11 个端口闭合、git diff --check 通过。浏览器视觉点击未单独验收，界面通过组件测试。
- 确认 5 个已有项目无进行中任务后按原授权重启应用栈，前端、API、路由 health 均 200。仅临时项目实测改名、稳定 ID/路径/标记文件、画布保存重读与来源链接、重名 409、非法名 400、旧名重用分配 _2，全部通过。
- 真实 LibTV 原名预读成功，标题含中文书名号、罗马数字及空格。临时项目按 ID 与解析后的根目录安全检查后清理；原 5 个项目全部数据库记录保持一致。未发模型请求，未修改凭据或本地工作流，未提交或推送。

### 2026-09-27 · 用户授权测试完成
- 用户追加“测试看看”，已重新取得锁并通过精确测试路径 preflight。新增回归仅涉及三条测试文件，原 name validation 测试补齐中文与非法输入断言，未再修改业务实现。
- 后端 `pytest tests/test_project_name_validation.py tests/ports/test_project_chinese_names.py tests/ports/test_project_registry.py tests/ports/test_project_local_uniqueness.py tests/test_project_context.py tests/test_api_project_summary_paths.py tests/test_project_id_route_paths.py tests/test_api_styles.py tests/test_project_spine_template.py -q`：87 passed；只有现有依赖弃用提示。
- 前端 `vitest run src/__tests__/routes/project-name-validation.test.tsx src/__tests__/routes/project-chinese-names.test.tsx src/__tests__/routes/project-first-liblib-import.test.tsx`：21 passed。包含中文创建弹窗原文提交、中文 64/65 字边界、非法输入和原首次导入容错。
- 后端回归覆盖 pinyin 转换、同音/ASCII别名/大小写冲突、截断重名、三个根目录旧文件保护、并发注册、归档和回收站保留路径、旧显式路径与部分覆盖、自定义风格按拼音 state_dir 更新。
- 当前服务通过前端 5173 代理实际创建两个仅本轮使用的中文同音项目，数据库显示拼音目录分别为原名和 _2；重复显示名 409、非法输入 400/422。
- 真实画布保存 revision 1、更新 revision 2 后重读中文内容一致；归档/取消归档、软删除/恢复后内容仍完整；另一个同音项目读不到此画布（404）。通过只读数据库核对真实目录和稳定 ID。
- 仅以本轮创建并记录的项目 ID 调用删除/清理接口；调用前核对名称、路径解析均位于仓库 output/state/runtime 根内，清理后两条记录及六个项目目录全部消失，原 5 个项目数据库记录完整相等。
- `tsc -b`、改动测试 ruff、前端 i18n 棘轮和 diff --check 通过。测试使用模拟组件和真实本地 API，未声称进行浏览器视觉点击验收；未发模型生成、未提交代码。

### 2026-09-27 · 中文名称与拼音目录实现并加载
- 以 `codex/project-chinese-names-20260927` 取得锁，10 个精确业务路径 preflight 通过。
- 前后端接受相同的 BMP 中文范围、ASCII 字母数字和下划线，保持 64 字符限制及禁止下划线开头；删除不用的 nameNoChinese 三语文案，同步 nameInvalid。既有测试仅移除过时的“中文必须拒绝”参数，未新增或运行测试。
- shared/project_dirs 新增仅用于创建的拼音目录名生成：无声调、下划线分隔、64 字符上限、罕见字码点兜底和 Windows 保留名避让；有效 ASCII 名称保留原拼写。
- CE registry 在 BEGIN IMMEDIATE 内分配默认目录，检查全部注册路径和磁盘占用；同音、大小写和截断碰撞追加 _2、_3 等序号，三个默认目录同名。显式目录覆盖保持兼容，不迁移任何旧项目。
- 通过代码审查确认 ProjectContext、列表摘要、画布任务与生命周期使用持久化路径；补齐更新自定义风格时的 state_dir 传递。
- 静态检查：改动 Python 文件 ruff check 通过；frontend 的 `tsc -b` 退出 0；三语 JSON 可解析；前后端 i18n 棘轮、git diff --check 和 agent guard check（31 工作线 / 1004 claims）通过。
- 按既有授权重启本地栈，5 项目未发现运行任务；API/config、前端首页、网关 healthz 均 HTTP 200；ComfyUI 与 H3 服务进程未变。未发生成请求、未创建或迁移真实项目，功能验收留给用户新建中文项目。
- 所有差异归本线业务文件与双方协调元数据；无配置密钥或本地工作流 JSON 改动。未提交或推送。

### 2026-09-27 · 方案就绪
已完成命名限制、注册表、上下文与风格读取代码审查；采用已有路径字段和 pypinyin，避免数据库迁移。初始 guard check 30 条工作线通过，无锁。下一步取得锁后按精确路径实现。

## 已定下来的决策
- 用户已指定中文项目目录使用拼音，显示名保留中文；无需再次询问。
- 不改变旧 default_project_dirs 的按路径片段拼接语义，新建时显式传入分配后的目录名。

## 待办
- [x] 实现、静态检查、服务加载和交接。

## 阻塞
无。

## 交接摘要
- **最后完成到**：132 项回归通过；服务已重启，中文改名与真实 LibTV 原名读取成功；临时数据清理完成。
- **下一步唯一动作**：核对同名远端提交结果，然后由用户刷新项目首页验收新增菜单与弹窗。
- **先读这些文件**：本台账、CE project registry、shared/project_dirs。
- **不要动这些文件 / 决策**：工作流 JSON、既有项目数据、密钥。


### 2026-09-27 · LibTV 分阶段导入协调
现有实现先完成，liblib-import-recovery 后串行增加节点先保存、素材进入画布后分批后台下载及结构化 404 兼容。仅合并精确差异，保留其他功能，由本线会话最终集成。
