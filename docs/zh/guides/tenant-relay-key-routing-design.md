# 用户自配虾驿 Key（BYOK）设计

> 状态：实施方案
>
> 代码基线：DramaClaw `freezone-canvas`；虾驿 = `claymore-llm-gateway`（QuantumNous/new-api fork）；EE = `SuperTale_main`（积分实现在 EE 侧 `ports_bootstrap.py`）
>
> 适用范围：起步与试用客户的共享实例。大客户走独立部署，不在本方案内。

## 0. 实施导读

**一句话：用户配了自己的虾驿 key，就用他的 key 且不扣积分；没配就用部署级 key 并正常扣积分。**

| 用户状态 | 用哪个虾驿 key | 成本是谁的 | DramaClaw 积分 |
| --- | --- | --- | --- |
| 未配置 | **部署级** key（SaaS 运营方配的） | 运营方 | **扣积分**（运营方靠此回收成本） |
| 配了自己的 | **用户级** key（BYOK） | 用户自己 | **不扣**（否则双重收费） |

要做的五件事：

| 序 | 做什么 | 主要文件 | 实测规模 |
| --- | --- | --- | --- |
| 1 | Agent 单例按 key 分桶 | `freezone/text_node.py`、`agents/global_video_optimizer.py`、`model_gateway_runtime.py` | 3 处同一模式，**getter 共 6 个调用点** |
| 2 | `tenant_relay_key` 表 + admin 接口 | `model_gateway_settings.py`、`api/routes/model_gateway.py` | ~120 行机械活，`settings.db` 与 `save_*` 模式现成 |
| 3 | `get_effective_newapi_config(username=...)`；BYOK 标记进 contextvars | `model_gateway_settings.py:499`、`llm_instrumentation.py`、`task_backend/run_core.py:196` | key 解析**仅 4 个调用点**；标记有**两个设置点**（请求入口 + 任务侧） |
| 4 | EE 的 `EEUsageMeter` 加 BYOK 判断 | EE 侧 `ports_bootstrap.py:170` | **一个类里加 6 个 `if`**；业务代码 37 处一行不改（§3.2） |
| 5 | 虾驿侧配置（用户 / token / 渠道 / `auto` 分组） | 虾驿后台或 admin API | **零代码**，纯后台配置 |

**合计约 250 行加测试。** 规模不大，原因是每处收口都很窄：`get_effective_newapi_config` 只有 4 个调用点、三个 Agent getter 合计 6 个调用点、扣费靠 EE 薄壳层 6 个 `if` 收口、虾驿侧零代码。

**扣费正确性只依赖三处**：一个判断函数（读 contextvar）、两个标记设置点（HTTP 请求入口与 `task_backend/run_core.py:196`）。验收覆盖这三处即可，不必逐个审查 37 个积分调用点（§3.2）。

**第 1 项必须先做，而且它是唯一的结构性障碍。** 不是「小心别写错」，而是现有的三个 `if is None` 让功能根本不成立——key 解析逻辑再正确，请求到那三处都会被第一个创建者的 key 覆盖（§3.4）。其余各项都属于照着改即可。

第 1 项还可以**独立于 BYOK 先落地**：改成按 key 分桶后，只有一个桶时行为与现在完全一致，等于一次无风险的结构清理，同时把这条路的唯一障碍拆掉。之后 BYOK 何时做都不再受它阻塞。

**路由逻辑零代码。** 用户的虾驿 key 背后是他在虾驿的账号；那个账号能用哪些模型、哪些走他自己的上游渠道、哪些回落到共享渠道，全部由虾驿的渠道配置与 `Ability` 表决定，DramaClaw 不写任何分流逻辑。

**DramaClaw 不需要知道钱怎么流到上游。** 用户虾驿账号的额度是他自己充、代充、还是绑了他的电信 TokenHub 渠道，都是虾驿侧与商务的事。DramaClaw 只回答一个问题：**这次请求用哪个虾驿 key，要不要扣积分。**

### 0.1 两层 key 的归属：部署级 vs 用户级

DramaClaw 可自部署（`_uses_ce_gateway_settings()` 与 `MODE_CUSTOM` 就是给自部署方指向自己网关用的），因此**「积分消耗的那个 key」不一定属于我们，而属于运营这个部署的人**——可能是官方托管服务，也可能是某个合作方自建 DramaClaw 对外做 SaaS。

| | key 归谁 | 谁承担上游成本 | 积分的作用 |
| --- | --- | --- | --- |
| **部署级 key** | SaaS 运营方（env / `custom` / `official` 三种来源） | 运营方 | 运营方向其用户收费、回收成本 |
| **用户级 key（BYOK）** | 该用户自己 | 用户自己 | 不参与——用户直接对自己的虾驿账号负责 |

所以本方案的准确描述是：**部署级 key 是默认路径且计积分；用户可以选择自带 key 走 BYOK 路径，此时积分不介入。**

这个划分让功能对自部署方同样有价值——他们运营 SaaS 时同样会遇到「大部分用户买我的积分，少数用户想用自己的 key」这个需求，实现完全一致，不需要区分官方托管与自部署。

文档下文统一用「**部署级 key**」指代运营方那把，用「**用户级 key**」或「**BYOK**」指代用户自带那把。凡出现「我们的 key」一类表述都应读作部署级 key。

### 0.2 前置决策：是否真的需要 BYOK

**动工前先确认这一条，因为不做 BYOK 的改动量是 0。**

如果上游额度（如电信 TokenHub）是由运营方代客户充值的，那这笔额度**完全可以挂在运营方自己的上游账号下**，变成虾驿里一条普通渠道：

```text
方案 A（BYOK，本文档）
    客户的上游账号 ← 运营方代充
    客户的虾驿 key → 虾驿用户 → 他自己的渠道
    DramaClaw 需认 username、Agent 分桶、跳积分       ≈ 250 行 + 4 件事

方案 B（不做 BYOK）
    运营方的上游账号
    虾驿加一条该上游的渠道，设高优先级
    客户照常买积分，DramaClaw 一行不改                零改动
```

**两个方案下客户拿到的东西完全一样**——用上该上游的模型、拿到运营方给的额度。差别只在凭证挂在谁名下。

方案 B 不成立、必须做 BYOK 的情形只有四种，**任一成立即需要本方案**：

1. 上游要求合同、发票或实名主体是客户本人；
2. 折扣或返点按客户主体计算，合并到运营方名下拿不到；
3. 客户坚持凭证自持，不接受额度放在运营方账号里；
4. **客户自己已有存量上游额度**，不是运营方代充的；
5. **渠道方需要按其推荐的客户归因真实消耗金额**——见下。

五条都不成立时，**不要做 BYOK**——方案 B 零成本达到同样效果，还省掉一张表、一套 admin 接口和 Agent 分桶。

第 4 条最常成立（客户带着已有额度来），此时 BYOK 是必做项。但仍建议先确认第 1、2 条，因为那是上游供应商的政策，不由我方决定。

#### 第 5 条单独说明：渠道归因是方案 B 结构上做不到的

推荐客户过来的渠道方（可能就是上游供应商本身）往往要知道**「我推荐的这些客户实际消耗了多少钱」**，用于结算返佣或评估投放效果。这一条方案 B 无法满足，原因有两层：

**① 积分不是钱，且不可反推。** 积分是运营方的内部计量单位，存在赠送、折扣、活动价、套餐差异。把积分数给渠道方，他无法换算成金额——换算比例本身是运营方的商业信息。

**② 方案 B 下上游只有一张总账。** 所有客户的消耗都发生在运营方同一个上游账号下，上游账单是合并的，**结构上无法按客户拆分**。运营方当然可以从自己的日志里算出每个客户的消耗并报给渠道方，但那是**自证**——渠道方要选择相信我方提供的数据。

BYOK 下每家客户拥有自己的上游账号，消耗以真实货币计价并直接落在该账号上，**渠道方在自己系统里就能看到**，无需信任第三方数据。这是自证与他证的区别，在涉及返佣结算时通常是硬要求。

因此这一条不只是「方案 B 做得差一点」，而是**结构上做不到**。若存在渠道返佣安排，BYOK 是必选项。

#### BYOK 换来什么：资金分离，以及少一批独立部署

上面只列了「什么情况下不必做」，也要写清做了能换来什么，否则决策是片面的。

**核心收益是资金与账目分离**，不是「避免独立部署」——后者方案 B 同样能做到（小公司在共享实例上买积分即可）。BYOK 多给的是：

- 每家客户的上游消耗走各自的账，不混在运营方一个池子里；
- 运营方**不必替客户垫资预付上游**；
- 客户能自己看到、自己控制自己的上游支出。

**由此产生一个隐性收益：它化解了独立部署的部分触发条件。** 对照 §9 的四条：

| §9 的触发条件 | BYOK 是否化解 |
| --- | --- |
| ① 合规：数据或凭证不与他人同库 | ❌ 不化解——客户 key 仍明文存在共享虾驿库里（§4.4） |
| ② 并发互扰 | ❌ 不化解 |
| ③ 客户要求自助管理凭证与账目 | ✅ **部分化解**——凭证是他的、账目分离了，但 key 仍由运营方代填代管 |
| ④ 模型清单或路由需求分歧 | ✅ **部分化解**——他可以有自己的渠道与模型清单（§4.1） |

所以 BYOK 的实际作用是：**让一批本来会因为 ③ ④ 而要求独立部署的小客户，留在共享实例上就能被满足。** 少一套独立部署省下的不只是服务器，还有本仓作为 fork 每次升级都要重新合并的成本（§9）。

这也解释了为什么它值得那 250 行：它不是一个技术让步，而是把「够格要求独立部署」的客户门槛往上抬了一档。

### 0.3 这是 EE 功能，CE 下惰性存在

**本功能的目标场景是 EE：一个部署服务多个付费用户，需要按用户区分 key 与计费。CE 不需要它。**

CE 是单机版，部署方配置自己的虾驿 key 或其他上游——这件事现有的 `MODE_CUSTOM`（`custom_newapi_base_url` / `custom_newapi_api_key`）已经在做，**部署方的 key 本来就是他自己的 key**，不存在多用户区分的需求。而且 CE 用 `NoOpUsageMeter`，本来就不扣积分。

因此工作项按仓库与版本拆开：

| 工作项 | 代码在哪 | CE | EE |
| --- | --- | --- | --- |
| Agent 单例按 key 分桶 | dramaclaw | 惰性（只有一个桶） | ✅ 需要 |
| `tenant_relay_key` 表 + admin 接口 | dramaclaw | 惰性（无记录） | ✅ 需要 |
| `get_effective_newapi_config` 加 `username` | dramaclaw | 惰性（不传即旧行为） | ✅ 需要 |
| BYOK 标记进 contextvars | dramaclaw | 惰性（无人读取） | ✅ 需要 |
| `EEUsageMeter` 加 6 个 `if` | **SuperTale_main** | ➖ 不适用 | ✅ 需要 |

前四项落在共享仓（dramaclaw），CE 会一并拿到，但**在 CE 下全部惰性**：没有 `tenant_relay_key` 记录 → 全部解析为部署级 key → Agent 分桶只有一个桶 → 行为与改造前完全一致。

**CE 侧唯一需要的验收是一条回归**：无 `tenant_relay_key` 记录时，行为与改造前逐字节一致。

#### 扣费验收归 EE 仓

积分相关的两条验收在 CE 下无法验证——CE 用 `NoOpUsageMeter`，谁都不扣，测试会「通过」但毫无意义：

- BYOK 用户不扣积分；
- 非 BYOK 用户扣积分行为与改造前一致。

这两条必须放在 EE 仓的测试里。两侧现有的测试布局正好对应这个分工：

```text
dramaclaw/tests/ports/          test_usage_noop.py                     ← 只有空操作实现
SuperTale_main/tests/ports/     test_usage_noop.py
                                test_usage_meter.py    ← 真实扣费，新增测试放这里
                                test_record_parity.py
```

CE 侧能验的是 key 解析与用量记录：两用户并发各自用对自己的 key、`enabled` 开关切换后解析正确、用量记录完整且 `credit_reservation_id` 为空。

#### 两个版本下 BYOK 的性质不同

- **EE**：用户自带 key → 不消耗运营方额度 → 不扣其积分，是**完整的商业能力**（key 隔离 + 计费隔离）；
- **CE**：无积分体系，若某个自部署方将来确实要区分用户 key，拿到的是**纯技术能力**（仅 key 隔离），如何向用户收费需在 CE 之外解决。

## 1. 现状与卡点

### 1.1 DramaClaw 现在是「一个部署一个 key」

`src/novelvideo/model_gateway_settings.py:499` 的 `get_effective_newapi_config()` **没有任何用户维度**，解析出的是进程级单值：

```text
_uses_ce_gateway_settings()?
├─ 否 → 环境变量 NEWAPI_API_KEY
└─ 是 → mode=custom  → settings.custom_newapi_api_key
        mode=official → settings.official_newapi_api_key
```

`src/novelvideo/newapi_provisioner.py` 的 `relay_token_name` 同样是全局单值（默认 `dramaclaw-ce-runtime`），配套函数是 `create_or_reuse_relay_token`（单数）。

官方网关地址在 `src/novelvideo/official_defaults.py:3`：

```python
OFFICIAL_NEWAPI_BASE_URL = "https://relayclaw.cdnfg.com/v1"
```

这套结构在「一个部署服务一个客户」时够用——部署本身就是边界。要支持用户自配 key，就必须补出用户维度。

### 1.2 DramaClaw 没有租户实体

代码里没有 org / tenant / company 模型，也没有用户表；数据按 `output/<user>/<project>/` 目录隔离。租户概念要新建，但**不需要引入数据库**——见 §2.1。

### 1.3 虾驿侧的原生能力已经齐了

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 路由表 | `model/ability.go` | `Ability(Group, Model, ChannelId)` + `Priority` / `Weight` |
| 分组解析 | `middleware/auth.go:421` | `token.Group` 为空则回退 `userCache.Group`；非空还要校验在该用户可用分组内 |
| 跨组回落 | `service/channel_select.go:84` | `token.Group = "auto"` 时按序遍历该用户的 auto 分组，某组没有该模型的可用渠道就跳下一组 |
| auto 分组计算 | `service/group.go:45` | `GetUserAutoGroup(userGroup)` = 全局 `AutoGroups` ∩ 该用户可用分组 |
| 渠道测试 | `controller/channel-test.go:828` | `TestChannel`，用于录入即时校验 |
| 消耗归因 | `model/log.go` | 同时有 `UserId` / `ChannelId` / `ChannelName` / `Group` / `ModelName` / `TokenName` / `Quota` |

**因此虾驿侧不需要改代码**，全部是后台配置或 admin API 调用。

## 2. `tenant_relay_key` 表

### 2.1 存哪里：用现成的 settings.db

`src/novelvideo/model_gateway_settings.py` 已有 SQLite 与建表逻辑：

```python
_settings_db_path()  →  {STATE_DIR}/local/settings.db     # 第 112 行
CREATE TABLE IF NOT EXISTS runtime_settings (...)          # 第 125 行
```

`api/routes/model_gateway.py` 已把 `save_official_newapi_key` / `save_custom_newapi_gateway` / `save_newapi_provider_channels` 等一批保存函数暴露成 admin 接口。**不引新库、不建新 admin 框架，沿用这套。**

### 2.2 表结构

```sql
CREATE TABLE IF NOT EXISTS tenant_relay_key (
  tenant_id    TEXT PRIMARY KEY,          -- 租户标识，见 §2.3
  tenant_name  TEXT NOT NULL DEFAULT '',  -- 展示名，admin 列表用
  relay_key    TEXT NOT NULL,             -- 用户自己的虾驿 key
  enabled      INTEGER NOT NULL DEFAULT 1,-- 排障开关，语义见 §2.4
  note         TEXT NOT NULL DEFAULT '',  -- 试用到期日、对接人等
  updated_at   INTEGER NOT NULL DEFAULT 0
);
```

**只有一个语义：这张表里有一条 enabled 的记录，就代表该用户自带 key 且自付成本。** 是否扣积分由此推导，不设独立字段（§3.2）。

### 2.3 `tenant_id` 取什么

当前没有租户实体，两个选项：

- **直接用 `username`**：适用于「一个 DramaClaw 用户 = 一个客户」的试用场景，最省事，先用这个；
- **另立 `tenant_id` 并给用户加归属**：一个客户下有多个 DramaClaw 用户时必需。

**结论：起步用 `username` 作主键，但表名与字段名用 `tenant_*`**，将来加 `user → tenant` 归属映射时只改解析函数，不改表结构。

### 2.4 `enabled` 是「是否走自己 key 这条路」的开关

它决定该用户走哪条路，两条路互斥：

```text
enabled = 1  →  走用户自己的虾驿 key，不扣积分（成本是用户的）
enabled = 0  →  走部署级 key，正常扣积分（成本是运营方的）
无记录       →  同上，走部署级 key + 扣积分
```

保留这个开关而不是只靠删记录，是为了**排障时能临时切回部署级 key**——怀疑用户 key 有问题时切一下验证，不用删记录（删了得让用户重新提供 key）。

**但它不是「停用客户」的开关**，这点必须写清，否则运营一定会误用：

```text
试用到期 → enabled 置 0 → 该用户开始用部署级 key 并扣积分
```

他积分为 0 时会被正常拦住，这是期望行为。但**如果送过体验积分、余额还在，他会继续用，花的是运营方的钱**。

所以：

- **「停用客户」要靠积分归零或独立的账号状态机制**，不能靠这个字段；
- admin 页面上这个开关建议标注为「**使用自己的 key**」，关闭时旁注「将改用平台 key 并扣积分」，不要写成笼统的「启用 / 停用」。

### 2.5 配套接口

```python
save_tenant_relay_key(tenant_id, *, relay_key, tenant_name, note, enabled)
list_tenant_relay_keys()          # admin 列表，relay_key 脱敏返回
get_tenant_relay_key(tenant_id)   # 内部解析用，返回明文
delete_tenant_relay_key(tenant_id)
```

挂到 `api/routes/model_gateway.py` 现有的 admin 路由上。**`list_*` 必须脱敏**（只回尾四位），admin 列表页没有理由展示完整 key。

## 3. DramaClaw 侧改造

### 3.1 `get_effective_newapi_config()` 加用户维度

现有签名（`model_gateway_settings.py:499`）：

```python
def get_effective_newapi_config(
    *,
    official_base_url: str | None = None,
    official_api_key: str | None = None,
) -> EffectiveNewApiConfig:
```

改为：

```python
def get_effective_newapi_config(
    *,
    username: str | None = None,          # 新增
    official_base_url: str | None = None,
    official_api_key: str | None = None,
) -> EffectiveNewApiConfig:
```

解析顺序：

```text
① username 非空 且 tenant_relay_key 命中 且 enabled=1
     → source="tenant"，api_key = 该用户自己的 relay_key
② 否则走现有逻辑（custom / official / environment），完全不变
```

**不传 `username` 时行为与改造前逐字节一致**，所以现有调用点不必全部改造，可按需逐步传入。这是本项能安全落地的前提。

`EffectiveNewApiConfig.source` 需增加 `"tenant"` 取值——它同时是下一节积分判断的依据。

### 3.2 积分跳过必须复用同一次查询结果

**不要在两处分别查 `tenant_relay_key`。** 一处决定用哪个 key、另一处决定扣不扣积分，两处判断迟早漂移，而且两个方向都是静默错误：

- 用了他的 key 却扣了积分 → 客户双重付费，系统一切正常无报错；
- 用了部署级 key 却没扣积分 → 运营方白送，同样无声无息。

正确做法：积分逻辑读 `EffectiveNewApiConfig.source`，`source == "tenant"` 即跳过预留与扣减，不重新查表。

`src/novelvideo/shared/billing_errors.py` 的 `InsufficientCreditsStop` 继承 `BaseException`（注释写明为了逃出宽泛的 `except`），一抛必然中断请求。**自带 key 的用户绝不能走到抛它的路径。**

三条路径的完整行为：

| 状态 | 用哪个 key | 积分预留与扣减 | 积分不足时 | 用量记账 |
| --- | --- | --- | --- | --- |
| `enabled = 1` | 他自己的虾驿 key | **跳过** | 不适用 | **照常记** |
| `enabled = 0` | 部署级 key | 正常 | 正常拦截 | 照常记 |
| 无记录 | 部署级 key | 正常 | 正常拦截 | 照常记 |

后两种情况的积分行为与改造前**逐字节一致**，`InsufficientCreditsStop` 一行不改——积分不够就是不够，正常拦住，不做任何特殊处理。

**注意「不扣积分」不等于「不记账」。** 只跳过积分的预留与确认，用量记录一条不少。原因：

- 虾驿的日志只到「一个虾驿用户」这一级。若一个客户下有多个 DramaClaw 用户，**只有 DramaClaw 有按人的粒度**；
- 客户想看「我们内部谁用了多少」时，这是唯一的数据来源；
- 记账与计费是两回事，写用量记录不触发任何扣费。

#### 精确到函数：跳哪些、不跳哪些

`src/novelvideo/ports/usage.py` 的 `UsageMeter` 协议把两件事分得很清楚。改造只动第一组，第二组一律照常调用：

```text
跳过（积分侧，source == "tenant" 时不调用）
    reserve_current_model_call_credit
    refund_model_call_credit_reservation
    reserve_feature_start_credits
    require_feature_credit_balance
    confirm_feature_credit_reservation
    refund_feature_credit_reservation

照常（用量侧，任何路径都调用）
    bump_model_call
    record_llm_tokens
    bump_content_counter
    log_resource_attempts
    set_llm_usage_context / set_project_llm_usage_context
    以及 video_request_usage.py / image_request_usage.py / audio_request_usage.py 三个 usage db
```

这个边界比「跳过扣减」这种描述可执行得多：**凡是带 `reservation` 语义的一组跳过，凡是 `bump_*` / `record_*` / `log_*` 的一组不动。**

##### 这份清单是给实现层的，不要在业务代码里逐处判断

积分侧这几个函数在业务代码中的调用面不小，实测：

```text
reserve_current_model_call_credit       10 处
refund_feature_credit_reservation       10 处
refund_model_call_credit_reservation     9 处
confirm_feature_credit_reservation       5 处
reserve_feature_start_credits            2 处
require_feature_credit_balance           1 处
                                    合计 37 处
```

**在 37 处各自加 `if source == "tenant"` 必然漏，而且漏掉的每一处都是一笔静默错账。**

正确做法是**单点收口**，业务代码那 37 处一行不改。收口点已确认，见下。

##### 收口点在 EE 的 `EEUsageMeter`（已确认）

先说清一件容易走错的事：**本仓 `src/novelvideo/ports/local/usage.py` 是 `NoOpUsageMeter`，所有积分方法都是空操作**：

```python
class NoOpUsageMeter:
    async def reserve_current_model_call_credit(...) -> str:
        return ""
    async def refund_model_call_credit_reservation(...) -> None:
        return None
    async def reserve_feature_start_credits(...) -> dict:
        return {"id": "", "cost": 0, "reserved": False, ...}
```

**CE 根本不扣积分**，在这个文件里加判断毫无意义。真实实现在 EE：

```text
EE ports_bootstrap.py:170   class EEUsageMeter
EE ports_bootstrap.py:478   register_port("usage_meter", EEUsageMeter())
```

而 `EEUsageMeter` 是**一层纯转发的薄壳**，积分核心逻辑在 `metrics_emit` 与 `credit_ledger` 里：

```python
class EEUsageMeter:
    async def reserve_current_model_call_credit(self, *, model, ...) -> str:
        return await metrics_emit.reserve_current_model_call_credit(...)      # 转发

    async def reserve_feature_start_credits(self, *, user_id, ...) -> dict:
        return await credit_ledger.reserve_feature_start_credits(...)         # 转发
```

**这层薄壳就是理想收口点**——在 6 个积分方法开头各加一句判断，不转发即返回空值：

```python
async def reserve_current_model_call_credit(self, *, model, ...) -> str:
    if _current_request_is_byok():
        return ""            # 返回值形状照抄 NoOpUsageMeter
    return await metrics_emit.reserve_current_model_call_credit(...)
```

返回值形状**照抄 `NoOpUsageMeter`**（`""` / `None` / `{"id": "", "cost": 0, "reserved": False, ...}`）——那是本仓现成、且已被 CE 长期运行验证过的空操作契约，不要自己设计。

由此得到三个结论：

- **不改 `metrics_emit` / `credit_ledger`**，积分核心逻辑一行不碰；
- **不需要包代理或替换 port 实例**，用量侧方法（`bump_model_call` / `record_llm_tokens` 等）原样不动，天然满足「不扣但要记」；
- **业务代码 37 处一行不改**。

EE 侧的实际工作量就是**在一个类里加 6 个 `if`**。

##### BYOK 标记走 contextvars，且任务侧会重建（已确认）

`EEUsageMeter` 的方法签名里没有 username，所以判断依据必须走请求级上下文。机制已确认可用：

`src/novelvideo/llm_instrumentation.py` 用的是 `contextvars.ContextVar`，且已有两个可直接照抄的先例：

```python
_USER_CTX: ContextVar[Optional[str]]                    # 用户 id 已在上下文里
_CREDIT_RESERVATION_STACK: ContextVar[tuple[str, ...]]
_AGENT_CREDIT_RESERVATION_ACTIVE: ContextVar[bool]      # 布尔标记的现成范式
```

新增一个 `_BYOK_ACTIVE: ContextVar[bool]`，在 `set_llm_usage_context()` 里一并设置即可——它已经是集中设置各个 contextvar 的地方。

**contextvars 的已知陷阱是跨线程与跨进程不传播**，而生成任务走 `task_backend`。这一点已确认不成问题：

```python
# src/novelvideo/task_backend/run_core.py:196
get_usage_meter().set_llm_usage_context(
    billing_user_id,
    project_id=...,
    resource_kind=_resource_kind_for_task(task_type),
    billing_metadata={...},
)
```

**任务侧会在任务开始处重新调用 `set_llm_usage_context`**，上下文是重建的，不依赖跨线程传播。所以只要在这一处也把 BYOK 标记一起设上，任务路径与请求路径行为一致。

这一处是实施时唯一需要小心的地方：**`run_core.py:196` 与 HTTP 请求入口两处都要设标记，漏掉任一处，对应路径的 BYOK 用户就会被误扣积分。** 验收里要分别覆盖同步请求与后台任务两条路径。

这样扣费的正确性只依赖「一个判断函数 + 两个设置点」，测试也只需覆盖这三处。**「扣费各自扣各自的」这件事由收口保证，不由 37 处的自觉保证。**

#### `credit_reservation_id` 天然就是路径标记

`bump_model_call` 的签名里有 `credit_reservation_id` 参数：

```python
async def bump_model_call(
    self, *, user_id, model="", project_id=None, resource_kind="",
    provider_request_id="", provider_task_id="",
    credit_reservation_id="",          # ← 走积分时有值，自带 key 时留空
    metadata=None,
) -> None: ...
```

自带 key 时**传空字符串即可，不要造一个假的预留 id**。这样这个字段是否为空，天然就是「这次有没有走积分」的标记，查历史时不必再关联 `tenant_relay_key` 或判断当时的配置——**配置会变，历史记录不会**。

#### 两条路径的记录差异

| 记录项 | 走积分（`enabled=0` / 无记录） | 自带 key（`enabled=1`） |
| --- | --- | --- |
| 积分预留 / 确认 / 退款 | ✅ 有 `reservation_id`，全程可追溯 | **跳过** |
| `bump_model_call` | ✅ 带 `credit_reservation_id` | ✅ `credit_reservation_id` 为空 |
| `record_llm_tokens` | ✅ | ✅ |
| `bump_content_counter` | ✅ | ✅ |
| `log_resource_attempts` | ✅ | ✅ |
| 三个 usage db | ✅ | ✅ |

**走积分的路径下每次调用既有积分凭据也有用量记录；自带 key 只少了积分凭据那一半。**

#### 两边各记什么：用量在 DramaClaw，费用在虾驿

这条划分决定「有问题该去哪查」，运营和客服都要知道：

| 要回答的问题 | 答案在哪 |
| --- | --- |
| 谁、什么时候、用了什么模型、多少量 | **DramaClaw** 的用量记录（`bump_*` / `record_*` / 三个 usage db） |
| 这次调用花了多少、走的哪条渠道 | **虾驿** 的 `Log`（`Quota` / `ChannelId` / `ChannelName` / `ModelName`） |
| 自带 key 的用户还剩多少额度 | **虾驿**（他自己账号的 quota） |
| 走积分的用户还剩多少积分 | **DramaClaw** |

所以自带 key 的用户如果问「我花了多少钱」，**答案在虾驿而不在 DramaClaw**——DramaClaw 只知道他用了多少量，不知道那些量在他自己账号里折算成多少费用（费率由虾驿的模型定价决定，且可能与我们给普通用户的积分定价不同）。

反过来，「他们团队内部谁用得多」只有 DramaClaw 答得出，因为虾驿只看到一个虾驿用户。**两边缺一不可，不要试图在一边凑全。**

#### 等价积分不单独存

「这次消耗值多少积分」可以从用量记录加计价规则算出来，**不冗余存一个可推导的值**，也不要为自带 key 的用户记一笔「扣 0」的流水——那只会在对账时造成困惑。

一个升级路径先记在这里：若将来要对这类客户出账或用于转付费报价，需要的是**当时的**等价积分，而计价规则会变。届时在 usage db 加一列 `equivalent_credits` 存快照即可，不影响任何现有逻辑。**现在不加**，因为还没有对这类客户出账的需求。

#### 前端积分展示要处理

`api/routes/auth.py:60-74` 会把 `credit_balance` 返回前端。自带 key 的用户这个值没有意义，若仍显示「本次消耗 100 积分」而余额一动不动，客户一定会来问。要么隐藏积分相关展示，要么标注「自付上游，不计积分」。

**这一条容易漏**：改后端的人通常想不到前端还挂着一个没意义的积分余额。

### 3.3 上游错误要翻译成可读提示

用户自己虾驿账号的额度耗尽、或他的上游渠道被禁用时，请求会失败。DramaClaw 不需要知道**为什么**没额度（那是虾驿侧与商务的事），但必须把上游错误翻译成人话，而不是把原始报错抛给用户——否则用户看到的是一个技术错误，无从判断是自己额度用尽还是系统故障。

这是 DramaClaw 在本方案里对上游唯一需要承担的责任。

### 3.4 Agent 单例按 key 分桶（唯一的结构性障碍，先做）

**这一项不是「小心别写错」，是「不改就等于没做」。** 其余各项都是照着改即可，这一项是现有代码结构本身与按用户取 key 冲突。

卡点在 `src/novelvideo/freezone/text_node.py:152`：

```python
def create_freezone_translation_agent() -> Agent:
    model = get_newapi_text_pydantic_model(       # ← key 在这一步被固化进 model 对象
        "FREEZONE_TRANSLATION_MODEL",
        FREEZONE_TRANSLATION_MODEL,
    )
    return Agent(model, ...)                      # ← Agent 持有这个 model


def get_freezone_translation_agent() -> Agent:
    global _translation_agent
    if _translation_agent is None:                # ← 只在第一次创建
        _translation_agent = create_freezone_translation_agent()
    return _translation_agent                     # ← 之后所有用户复用同一个
```

`get_newapi_text_pydantic_model()` 内部调 `get_effective_newapi_config()` 取 key 并**塞进 model 对象**，Agent 持有该 model，于是 key 跟着 Agent 固化。配上 `if is None`：

```text
用户 A（自带 key）第一个请求 → 创建 Agent，内含 A 的 key
用户 B 请求                  → 单例非 None → 直接复用 → 用了 A 的 key
```

**key 解析逻辑再正确，请求到这三处都会被第一个创建者的 key 覆盖。** 失败特征是「静默 + 昂贵 + 事后才发现」：上游正常返回，只有对账时才暴露。

三处同一模式：

| 位置 | 现在 | 改成 |
| --- | --- | --- |
| `text_node.py:136` | `_translation_agent: Optional[Agent]` | `dict[str, Agent]` |
| `text_node.py:137` | `_story_script_agent: Optional[Agent]` | 同上 |
| `global_video_optimizer.py:833` | `_global_video_optimizer: Optional[...]` | 同上 |

改法：

```python
_translation_agents: dict[str, Agent] = {}

def get_freezone_translation_agent(username: str | None = None) -> Agent:
    gateway = get_effective_newapi_config(username=username)
    bucket = _runtime_version(gateway.api_key, gateway.base_url)   # 现成的指纹函数
    if bucket not in _translation_agents:
        _translation_agents[bucket] = create_freezone_translation_agent(username=username)
    return _translation_agents[bucket]
```

**按 key 指纹分桶，不要按 username 分桶。** 所有未配置 BYOK 的用户共用部署级 key，应当共享同一个 Agent 实例；按 username 分桶会给每个用户建一份，Agent 创建有开销，且内存无界。

指纹函数沿用现成的：

```python
def _runtime_version(api_key: str, base_url: str) -> str:      # model_gateway_runtime.py
    material = f"{base_url}\n{api_key}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:16]
```

`global_video_optimizer` 稍特殊——它内部**已有**一层按语言的字典（`self._agents[language]`，第 223 行），因此是在外面再套一层 key 分桶，或把 key 并入它的缓存键。

要求：

- 缓存键必须同时覆盖 `api_key` 与 `base_url`，只用其一会在自定义网关场景串号；
- `_clear_agent_singletons()` 相应改为清空整个字典（或按指纹清指定桶）；
- 桶要有上限与淘汰策略（建议 LRU），否则用户来回开通会无界增长。

**Cognee 要单独确认。** `_cognee_runtime_status()` 的注释写明：

> Cognee is process-global and must be restarted after its active gateway changes.

Cognee 是进程全局且换 gateway 需要重启。**本项必须先确认它是否只使用部署级 key**；若是，在文档与代码注释里写死这条边界；若不是，Cognee 的多 key 支持要单列一项工作，不要混在本方案里。

## 4. 虾驿侧配置

### 4.1 每个自配 key 的用户，四步

全部可通过 admin API 调用：

```text
① 建虾驿用户    Group = tel-<用户>              ← 额度池 + 路由钥匙
② 建 token      归属该用户，Group 留空           ← 这就是给用户的 relay_key
③ 建上游渠道
       Key      = 该用户的上游 key（如电信 TokenHub key）
       BaseURL  = 上游端点
       Models   = 只填该上游真有的模型             ← 这一栏就是「哪些模型走他自己的渠道」
       Group    = tel-<用户>
       Tag      = tel · tokenhub                 ← Tag 有索引，用于批量统计
       Priority = 高
④ 设置项
       可用分组映射  加 { tel-<用户>: [tel-<用户>, default] }
       全局 AutoGroups 列表 加 tel-<用户>（default 保持在末尾）
```

`tel-` 前缀只是命名约定（表示上游来源是电信），虾驿不认识它。以后接入其他上游来源时，前缀能立刻区分，排障与统计都更方便。

### 4.2 用 `auto` 分组，不要把共享渠道追加到用户组

`model/channel.go:40` 的 `Channel.Group` 是 **`varchar(64)`**，逗号分隔，只装得下三五个组名。**用户数上来后必定溢出**，所以不要走「共享渠道追加每个用户组」这条路。

正确做法是 `token.Group = "auto"`，依赖 `service/channel_select.go:84` 的按序遍历：

```go
autoGroups := GetUserAutoGroup(userGroup)   // 全局 AutoGroups ∩ 该用户可用分组
for i := startGroupIndex; i < len(autoGroups); i++ {
    channel, _ = model.GetRandomSatisfiedChannelWithExcludedTypes(autoGroup, param.ModelName, ...)
    if channel == nil { continue }          // 该组没有这个模型 → 试下一组
```

效果：**先在自己的 `tel-` 组找，他上游有的模型命中他自己的渠道；没有的自动落到 `default` 的共享渠道。** 共享渠道永远只属于 `default` 一个组，一动不动。

用户组只出现在**设置项**（可用分组映射 + AutoGroups 列表）里，那是 JSON，不受 64 字符限制。

**这条要一开始就用。** 等溢出后再改需要重算所有已有用户的可用分组配置，比一开始就用麻烦得多。

### 4.3 绝对不要用多 Key 模式装多个用户的 key

`model/channel.go` 的 `ChannelInfo.IsMultiKey` / `MultiKeyPollingIndex` 允许一条渠道装多把 key，看起来能省下建多条渠道的功夫。**但它是轮询：**

```go
channel.ChannelInfo.MultiKeyPollingIndex = (idx + 1) % len(keys)
```

拿它装不同用户的 key，结果是 **A 用户的请求随机用 B 用户的 key 付费**。这是计费灾难，且上游成功返回、难以发现，只有客户对账时才炸。

**必须一个用户一条渠道。** 这条要写进运维文档。

### 4.4 客户 key 明文存储，用访问控制兜住

`Channel.Key` 在虾驿库中**明文存储，也没有脱敏返回**（代码中查不到任何 encrypt / mask 逻辑）。以前存的是我们自己的 key，现在存的是**客户的凭证**，泄露性质从内部事故变成对客户的责任事故。

最低限度：

- 收紧虾驿数据库与后台的访问权限；管理员分级（`model/authz_role.go` 有角色机制），不要所有运营都是超管；
- **数据库备份同样是明文**，备份的存放与访问要一并管；
- 合同里写清 key 的保管责任。

**不建议现在做加密存储**：改 `Channel.Key` 的读写路径会牵动多 Key 模式、渠道测试、缓存多处，而本仓是 fork，每次升级都要重新合并。客户若不接受 key 与别家同库，那正是**独立部署的触发条件**，用部署隔离解决，而不是改加密。

## 5. 权限边界：谁能配、谁能改

三样东西三种权限，必须严格分开：

| 配置项 | 我们预配 | 用户能改 | 理由 |
| --- | --- | --- | --- |
| **虾驿 key（`relay_key`）** | ✅ | ❌ 连看都不该看到完整值 | 这是用户在虾驿的凭证，拿到就能绕过 DramaClaw 直打虾驿，本地的记账、限额、审计全部失效 |
| **上游 key（如电信 TokenHub key）** | ✅ 代填 | ✅ 可以开放 | 是他自己的凭证；让他自己填还能避免 key 走 IM / 邮件 |
| **`enabled` 开关** | ✅ | ❌ | 它决定成本落在谁身上（§2.4），是我们的运营与商业动作 |

**不能给用户虾驿后台权限。** 渠道管理是实例级的，他会看到并可能改到别家用户的渠道。若要开放上游 key 的自助录入，边界必须是：用户在 DramaClaw 界面填 key，后端持虾驿 admin 凭证**只操作他自己那一条渠道**，并立即调 `TestChannel`（`controller/channel-test.go:828`）校验后回显结果。用户从头到尾不接触虾驿。

自助录入入口暂不排期，理由见 §8。

## 6. 明确不做

- **不加 `billing_mode` 一类的独立字段。** 「有没有配自己的 key」本身就决定了要不要扣积分，两件事由同一事实驱动（§3.2）。加独立字段会引入「配了 key 但忘改模式 → 双重收费且无报错」的坑；
- **不在各生成路径上分散判断。** key 解析与积分跳过只在一处产生结论（`EffectiveNewApiConfig.source`），漏一处就是一个静默的双重扣费或白送；
- **不把上游 key 存进 DramaClaw。** 它只存在虾驿的渠道里，凭证一处存放、一处轮换；
- **不把虾驿 key 下发给用户。** 见 §5；
- **不给用户虾驿后台权限。** 渠道管理是实例级的；
- **不改虾驿的路由代码。** `Ability(Group, Model, ChannelId)` 原生够用，分流靠渠道 `Models` 字段声明；
- **不把共享渠道追加进每个用户组**（`varchar(64)` 会溢出，走 `auto`，见 §4.2）；
- **不用多 Key 模式承载多用户**（轮询会串账，见 §4.3）；
- **不在虾驿做加密存储**（fork 合并成本高，用访问控制与独立部署解决，见 §4.4）；
- **不让 DramaClaw 关心上游的钱从哪来。** 用户虾驿账号的额度是他自己充、我们代充、还是绑了他的上游渠道，都是虾驿侧与商务的事；
- **不为「一个租户内按人分账」做用户级 key。** 正确做法是同一虾驿用户下建多个 token，共用一个额度池，`Log.TokenName` 天然分账，不必多建渠道与分组。

## 7. 分期与验收

### 7.1 分期

| 期 | 内容 | 触发条件 |
| --- | --- | --- |
| 一 | §3.4 Agent 单例分桶（含 Cognee 边界确认） | 立即，独立于其余项；CE/EE 共享，CE 下只有一个桶、行为不变 |
| 二 | §2 表 + §3.1 解析改造 + §3.2 积分跳过 + §3.3 错误翻译；虾驿侧手工配前两个用户 | 有第一个自配 key 的客户 |
| 三 | §4.1 开通自动化（四步 API）；回落归因看板（§7.3） | 月开通量超 5 个，或客户要求自助轮换 key |

### 7.2 验收

验收按仓库分开，**扣费相关两条只能在 EE 仓验证**（§0.3）：

| 验收项 | 在哪个仓跑 |
| --- | --- |
| 无 `tenant_relay_key` 记录时行为与改造前一致 | dramaclaw（CE 唯一必需的回归） |
| 两用户并发各自用对自己的 key | dramaclaw |
| `enabled` 开关切换后 key 解析正确 | dramaclaw |
| 用量记录完整、`credit_reservation_id` 为空 | dramaclaw |
| BYOK 用户不扣积分 | **SuperTale_main**（`tests/ports/test_usage_meter.py`） |
| 非 BYOK 用户扣积分行为与改造前一致 | **SuperTale_main**（同上） |

具体条目：

- 不传 `username` 时 `get_effective_newapi_config()` 输出与改造前逐字节一致（回归）；
- 两个用户并发发起文本生成，**各自实际使用的 api_key 与其配置一致**——这条是 §3.4 的核心，必须测并发，只测「能取到正确 key」不够；
- 配了自己 key 的用户：请求走他的 key，**且不扣积分**，但 `bump_model_call` / `record_llm_tokens` / 三个 usage db **仍有完整记录**，其中 `credit_reservation_id` 为空（§3.2）；
- **同步请求路径与后台任务路径分别验证不扣积分**——BYOK 标记有两个设置点（HTTP 入口、`task_backend/run_core.py:196`），漏掉任一处该路径的用户就会被误扣（§3.2）；
- 未配置的用户：请求走部署级 key，**且正常扣积分与拦截**（回归）；
- `enabled = 0` 后该用户切回部署级 key，并**恢复扣积分**（§2.4 的语义）；
- 他上游渠道 `Models` 里有的模型落在他自己的渠道上；不在其中的落到 `default` 共享渠道；
- 他的虾驿额度耗尽时，前端给出可读提示而不是原始上游错误（§3.3）；
- admin 列表页的 `relay_key` 为脱敏展示。

### 7.3 回落归因（归运营，但建议早做）

用户自配 key 时，他上游没有的模型会落到我们的共享渠道——**那部分是我们的成本**。

`model/log.go` 的 `Log` 已同时具备 `UserId` / `ChannelId` / `ChannelName` / `Group` / `ModelName` / `TokenName` / `Quota`，`Channel.UsedQuota` 也按渠道累计。**不需要改任何代码**，一条查询即可按用户拆出「总消耗 / 走他自己渠道 / 回落共享渠道」三个数。

按 §4.1 的 `Tag` 规范打标后，「所有自配渠道的消耗」也是一条查询。**第一条渠道就要打对 Tag**，几十条之后没法回头统一。

必须有的告警：`AutoBan` 会自动禁用连续失败的渠道。用户上游 key 过期或额度耗尽时，**渠道一被禁用，他的全部请求就落到共享渠道，变成我们付钱**，而他又不扣积分——没有任何机制能挡住。因此：

- 用户的上游渠道被禁用时**立即告警**；
- 单用户回落消耗超阈值时告警；
- 明确策略：此时是继续替他付还是直接拦截。**默认建议拦截**——替客户付费应当是显式决定，不能是系统默认行为。

## 8. 待定项

**用户自助录入上游 key vs 我们代填** —— 起步阶段先代填，本方案不下结论。

不宜过早建自助入口的理由：此时还不清楚客户是否愿意自己操作（部分企业客户更希望我们代管）、上游 key 的实际形态（是否带 secret、endpoint 是否各家不同）、以及一个客户是否会提供多把 key（不同额度池或模型套餐）。这些没摸清就做入口，大概率要重做。

代填两三个客户后形态即清楚。届时若做入口，边界见 §5。

**一个边缘场景，现在不做但记一句**：如果以后出现「我们给某个用户单独配一个**我们自己的**虾驿 key」（例如给 VIP 隔离额度与限流，但成本仍是我们的），那时「表里有记录」就不再等于「他自己付钱」，需要加一个布尔区分。**现在不加**——该场景不存在，真出现时加一个 `deduct_credits` 布尔即可，不影响表结构。

## 9. 何时改为独立部署

大客户走独立部署已是既定策略。这里只记录判据，避免误判。

独立部署应由触发条件决定，出现任一即应独立，与消耗金额无关：

1. **合规**：客户要求数据或凭证不与其他客户同实例、同库；
2. **并发互扰**：该用户的流量峰值影响到其他用户；
3. **自助管理**：客户要求自行管理渠道与凭证（虾驿后台是实例级的，无法只开放一部分）；
4. **配置分歧**：模型清单或路由需求差异大到分组机制无法表达。

要把隐性成本计入：本仓是 fork，已有自定义提交（Huimeng 路由、计费改动等）。**每多一套独立部署，后续升级的合并与验证成本就乘一次**——这通常比服务器费用更值得先算。
