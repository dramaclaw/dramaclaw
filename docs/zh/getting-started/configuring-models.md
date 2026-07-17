<!-- lang-switch -->
[English](../../en/getting-started/configuring-models.md) · **简体中文**

# 配置模型供应商

DramaClaw CE 通过 NewAPI 兼容网关接入文本、图片、视频、音频和 embedding 模型。可以使用官方 RelayClaw，也可以使用 CE 随附的本地 NewAPI。

## 先选一种接入方式

| 方式 | 适合场景 | 是否需要映射模型 |
|---|---|---|
| 官方渠道 / RelayClaw | 想最快跑通，使用官方预置模型 | 不需要 |
| 本地 NewAPI | 希望在 DramaClaw UI 里配置本机 NewAPI 的上游渠道、模型映射、媒体模型和 embedding | 需要在 UI 里保存映射 |

## 配置入口

启动后打开 `http://localhost:8080`，进入设置 → 模型配置。渠道选择、网关地址和 token 都保存在本机 `settings.db`，不从环境变量读取。

启动后打开 `http://localhost:8080`，进入设置 -> 模型配置。

在网页里可以完成：

- 官方渠道：填写 RelayClaw DC key，点击“保存并启用”。官方地址固定。
- 本地 NewAPI：初始化本机 NewAPI、创建或复用 runtime token、配置供应商渠道、保存模型映射。
- 媒体存储：配置 OSS 或 Cloudinary。
- Embedding：配置模型、维度和批量大小。

更换 key、渠道或模型后，新任务会读取新配置；已经运行中的任务不会强制中途切换。

如果启用网页“本地 NewAPI”初始化向导，只需开启 provisioner：

```bash
NEWAPI_PROVISIONER_ENABLED=true
NEWAPI_ADMIN_BASE_URL=http://127.0.0.1:3000
```

CE 固定使用 `${NOVELVIDEO_STATE_DIR}/newapi/one-api.db`，无需配置数据库 DSN、
SQLite 路径或管理员用户名。

## A. 官方渠道 / RelayClaw 推荐

默认 `docker-compose.yml` 已使用官方渠道。启动后：

1. 浏览器打开 `http://localhost:8080`。
2. 进入设置 -> 模型配置 -> 官方渠道。
3. 网关地址默认是 `https://relayclaw.cdnfg.com/v1`。
4. 粘贴你的 DC key，点击“保存并启用”。

RelayClaw 后台已经配置好 DramaClaw 需要的逻辑模型名，所以不需要手动映射 `*_MODEL`。

还没有 DC key 时，到 <https://relayclaw.cdnfg.com> 注册 / 购买。

如果你只是更换 DC key，直接在网页里更新并保存即可。

## B. 本地 NewAPI

“本地 NewAPI”适合 CE 单机用户在 DramaClaw 设置页里管理：

- NewAPI runtime token。
- 上游供应商渠道和 key。
- 文本、图片、视频、音频模型映射。
- Cognee embedding 模型、维度和批量大小。

### 1. 准备 NewAPI

如果用仓库内置 selfhosted 编排：

```bash
docker compose -f docker-compose.selfhosted.yml up -d --build
```

该编排会启动 `api`、`web` 和内置 `newapi`。NewAPI 后台默认在 `http://localhost:3000`。

`docker-compose.selfhosted.yml` 会把同一个 `newapi-data` 卷分别挂载到 NewAPI 的
`/data` 和 DramaClaw API 的 `/newapi-data`。初始化向导会调用 NewAPI `/api/setup`
创建 root 管理员，再创建或复用 runtime token；用户无需进入 NewAPI 后台复制令牌。

### 2. 初始化配置

进入设置 -> 模型配置 -> 本地 NewAPI：

1. 如果 NewAPI 尚未初始化，为 root 管理员设置首次初始化密码。
2. 点击“初始化本地 NewAPI”。

初始化按钮会做这些事：

- 如果 NewAPI 没初始化，调用 NewAPI `/api/setup` 创建管理员。
- 如果 NewAPI 已初始化，会跳过管理员创建；你填的初始化密码不会修改已有管理员密码。
- 创建或复用名为 `dramaclaw-ce-runtime` 的 runtime token。
- 把 runtime token 写入 DramaClaw 本地配置数据库。
- 将模型网关模式切换为 `custom`。

管理员密码只用于首次初始化 NewAPI。DramaClaw 不保存这个密码，也不会用它做后续管理操作。初始化完成后请自行保存 NewAPI 管理员账号密码，用于登录 NewAPI 后台。

推荐直接使用 DramaClaw 初始化向导：不需要先注册 NewAPI；在设置页填写首次管理员密码并点击“初始化配置”，runtime token 会自动保存到 `settings.db`。

如果 NewAPI 已经初始化过，初始化密码可以留空；点击“初始化配置”只会创建或复用 DramaClaw runtime token，不会重置已有管理员密码。

### 3. 配置供应商渠道

供应商渠道用于保存上游模型厂商的 key 和可选 Base URL 覆盖，例如 Ali、OpenRouter、OpenAI、Midjourney 等。

页面里的按钮含义：

- “保存渠道配置”：只保存到 DramaClaw 本地配置，作为后续模型映射的渠道预设；不会立刻修改 NewAPI 已有渠道。
- “更新 NewAPI 渠道”：立刻把当前这一行的 key / Base URL 更新到 NewAPI 对应渠道。
- “保存模型映射”：根据当前文本、图片、视频、音频、embedding 映射，把需要的渠道和模型写入 NewAPI，并保存本地配置。

如果你更换某个逻辑模型的供应商，保存映射时会把该逻辑模型从旧渠道的模型列表移除，再写入新渠道，避免 NewAPI 在多个渠道之间随机选择同名模型。

### 4. 配置模型映射

DramaClaw 使用一组内部逻辑模型名。你可以把每个逻辑模型映射到某个供应商渠道和真实上游模型。

页面里的模型配置分为几类：

- 纯文本模型：只发送文本输入，例如 Hermes、Cognee、身份规划、场景规划、道具规划、内容改写、脚本规范化等。
- 多模态模型：会把图片发送给上游模型，例如 AI 优化提示词、AI 检测身份与道具颜色标记、上传参考图创建自定义风格。这里必须选择支持图片输入 / 视觉理解的上游模型；纯文本模型可能运行失败。
- Embedding：`DC-cognee-embedding`，用于导入小说、Cognee 建图和向量检索。
- 图片：`LingShan-G2`、`LingShan-NB-2` 及场景、角色、草图相关图片模型。
- 视频：`seedance-*`、`happyhorse-1.0` 等。
- 音频：`index-tts-2`、`LingShan-MU-11` 等。

纯文本模型和多模态模型区块顶部都有批量填充控件。选择渠道、填写上游模型名后点击“应用到全部”，只会把当前区块的模型草稿填到页面里，不会立即写入 NewAPI。你可以继续展开分组，单独调整某一行的渠道或上游模型名；最后点击“保存映射”才会写入 NewAPI 并保存到 DramaClaw 本地配置。

如果使用 RelayClaw 官方 DC key，可以跳过映射；官方已配置好默认逻辑模型。

如果使用本地 NewAPI，请保持 DramaClaw 内部逻辑模型名不变，只在 NewAPI 渠道里映射到真实上游模型。

## Embedding 批量大小

Cognee 建图会批量调用 embedding。默认批量大小是 36：

```bash
EMBEDDING_BATCH_SIZE=36
```

不同上游 embedding 模型的单请求 `input` 数量上限不同：

- Gemini 类 embedding 通常可以使用 36。
- 部分 Qwen / 阿里 embedding 模型上限较低，建议设为 10。

如果建图阶段出现 embedding HTTP 400/422，且错误发生在导入小说或 Cognee 阶段，优先检查：

1. embedding 真实模型是否支持当前维度。
2. `EMBEDDING_BATCH_SIZE` 是否超过上游单请求 input 上限。
3. NewAPI 渠道里 `DC-cognee-embedding` 是否映射到了正确的 embedding 模型。

在本地 NewAPI 页面保存 Embedding 配置时，维度和批量大小会同时保存到本地配置；后续建图优先使用本地配置。

## 参考媒体 relay

当上游模型需要读取本地参考图、首帧、角色图或身份图时，DramaClaw 需要先把本地文件上传到一个公网可访问的临时地址，再把 URL 传给模型网关。

纯文本流程、纯文生图流程通常不需要配置参考媒体 relay。图生图、视频首帧、角色参考图、身份图、Freezone 图片参考等场景会用到。

支持两种方式：

### 阿里云 OSS

阿里云 OSS 需要先在阿里云控制台创建 Bucket，再创建一个有该 Bucket 读写权限的 AccessKey。推荐使用只授权到该 Bucket 的 RAM 子账号，不要使用主账号 AccessKey。

```bash
MEDIA_RELAY_PROVIDER=aliyun_oss
OSS_RELAY_ENDPOINT=oss-cn-chengdu.aliyuncs.com
OSS_RELAY_BUCKET=你的_bucket
OSS_RELAY_AK=你的_access_key_id
OSS_RELAY_SK=你的_access_key_secret
MEDIA_RELAY_TTL_SECONDS=1800
```

字段说明：

| 网页字段 | 环境变量 | 说明 |
|---|---|---|
| Endpoint / 地域 | `OSS_RELAY_ENDPOINT` | OSS 外网 Endpoint，不要带 `https://`，例如 `oss-cn-chengdu.aliyuncs.com`。 |
| Bucket | `OSS_RELAY_BUCKET` | 用于临时参考图 relay 的 Bucket 名称。 |
| AccessKey ID | `OSS_RELAY_AK` | 有 Bucket 上传和签名读取权限的 AccessKey ID。 |
| AccessKey Secret | `OSS_RELAY_SK` | 对应的 AccessKey Secret。 |
| 有效期 | `MEDIA_RELAY_TTL_SECONDS` | 生成签名 URL 的有效时间，默认 1800 秒。 |

Bucket 需要允许后端上传对象，并能生成临时签名 URL 供上游模型读取。一般不需要把 Bucket 设为公开读；DramaClaw 会使用签名 URL 暂时授权访问。建议单独建一个 Bucket 或独立前缀，只给 DramaClaw 存放参考图临时文件。

### Cloudinary 免费方案

还没有 Cloudinary 账号时，到 <https://cloudinary.com/users/register_free> 注册免费账号。

```bash
MEDIA_RELAY_PROVIDER=cloudinary
CLOUDINARY_RELAY_CLOUD_NAME=你的_cloud_name
CLOUDINARY_RELAY_API_KEY=你的_api_key
CLOUDINARY_RELAY_API_SECRET=你的_api_secret
CLOUDINARY_RELAY_FOLDER=relay
MEDIA_RELAY_TTL_SECONDS=1800
```

Cloudinary 的 Cloud name、API Key、API Secret 可以在 Cloudinary 控制台的 API Keys 页面查看。进入控制台后，打开 Product environment settings -> API Keys，即可看到 `CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>` 格式的提示。

`CLOUDINARY_RELAY_FOLDER` 对应网页里的“API 文件夹（可选）”。这里填的是 Cloudinary 后台里的 folder 名称，不是本地文件夹路径。例如填 `dramaclaw-relay` 后，上传的参考图会放在 Cloudinary 的 `dramaclaw-relay` 文件夹下，便于后台管理；留空时上传到 Cloudinary 根目录。

网页设置中保存媒体存储配置后，本地 SQLite 配置优先生效，后端不会回传完整密钥给前端显示。

## 常见问题

| 现象 | 处理 |
|---|---|
| 保存官方渠道后仍调用旧 key | 确认当前生效渠道是否为“官方渠道”；新任务会读取最新本地配置，已在运行中的任务不会强制中途切换。Cognee 已初始化时需要重启 DramaClaw。 |
| 本地 NewAPI 初始化失败 | 确认本地 NewAPI 服务已启动、SQLite 文件目录可写、`NEWAPI_PROVISIONER_ENABLED=true` 是否生效。 |
| 已初始化 NewAPI 后再次填密码点击初始化 | 不会修改已有管理员密码；密码只在首次初始化时使用。 |
| NewAPI 报 `No available channel for model ...` | 对应逻辑模型没有写入 NewAPI 渠道，或渠道未启用，或模型映射保存失败。 |
| 更换供应商后仍偶尔走旧渠道 | 检查 NewAPI 后台是否存在多个渠道同时包含同一个逻辑模型；重新保存模型映射或更新对应渠道。 |
| embedding 建图 400/422 | 降低 `EMBEDDING_BATCH_SIZE`，并确认 embedding 模型、维度和渠道映射正确。 |
| 参考图 / 视频首帧上传失败 | 检查 OSS 或 Cloudinary 配置；纯文本流程不需要媒体 relay，但带参考图的图片/视频模型需要。 |

## 相关文件

- `.env.example`：完整环境变量列表和默认值。
- `docker-compose.yml`：默认官方渠道部署。
- `docker-compose.selfhosted.yml`：内置 NewAPI 自托管部署。
- [自托管手册](../guides/self-hosting.md)
- [环境变量参考](../reference/environment-variables.md)
