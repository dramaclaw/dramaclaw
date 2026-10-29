<!-- lang-switch -->
[English](../../en/guides/self-hosting.md) · **简体中文**

# 自托管手册（Docker）

> 用 Docker 部署、配置、升级、备份 DramaClaw CE。

CE 三个容器：`api` + `newapi`（内置 DramaClaw 网关，切到自定义/本地 + 官方混合模式前闲置）+ `web`，**无 PostgreSQL / 无 Redis / 无 Celery**（`ST_EDITION=ce`，任务在进程内 inline 执行）。模型默认走 DramaClaw 官方网关。

仓库里有两份 compose 文件：`docker-compose.yml` 源码构建三个服务（默认入口 —— `docker compose up -d --build`），`docker-compose.release.yml` 只拉已发布镜像（`docker compose -f docker-compose.release.yml up -d`）。`docker-compose.yml` 通过 `extends` 复用 `docker-compose.release.yml` 里的运行定义（env / 端口 / 卷 / 健康检查），并添加本地构建、本地镜像名和源码运行时覆盖配置。

## 1. 前置

- Docker + `docker compose`。
- Docker Compose ≥ 2.24（`docker compose version` 确认）。
- 资源：建议 ≥ 2 vCPU / 4GB（不含模型推理，推理走外部网关）。
- 一个 DC key（默认官方网关 RelayClaw,见 <https://relayclaw.cdnfg.com>），或自己的 OpenAI 兼容网关。

## 2. 拿到 compose 与配置

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
git clone https://github.com/dramaclaw/dramaclaw-gateway.git   # 只有源码构建需要；镜像模式不用
cd dramaclaw
cp .env.example .env
```

选择其中一种；镜像模式还需按下文在 `.env` 中指定发布版本：

| 文件 | 模式 | 命令 |
|---|---|---|
| `docker-compose.yml` | 源码构建（默认）—— `api`、`web` 用本仓 checkout，内置网关用 `../dramaclaw-gateway`（`DRAMACLAW_GATEWAY_SRC` 可改成别的路径或 git 地址） | `docker compose up -d --build` |
| `docker-compose.release.yml` | 只拉镜像，不构建 | `docker compose -f docker-compose.release.yml up -d` |

两者共享的关键点（定义在 `docker-compose.release.yml` 里，`docker-compose.yml` 通过 `extends` 复用）：

| 项 | 值 | 说明 |
|---|---|---|
| 服务 | `api` + `newapi` + `web` | 无 PG/Redis；`newapi` 是内置网关 |
| 镜像（release） | `${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/...` | 默认拉 Docker Hub；`.env` 设 `DRAMACLAW_IMAGE_PREFIX` 切到 ACR 镜像（只有钉 tag） |
| 版本（release） | `DRAMACLAW_VERSION`（api/web）、`DRAMACLAW_GATEWAY_VERSION` | 当前版本请在 `.env` 中显式指定 `2.1.0` / `v1.0.0-rc.24-dramaclaw.3` |
| 虾导后端 | `DRAMACLAW_CHAT_BACKEND` | 源码和发布版 Compose 均默认 `codex` |
| 端口 | `8780:8780` | REST API |
| 网关管理端口 | `${ST_NEWAPI_BIND:-127.0.0.1}:${ST_NEWAPI_PORT:-3000}:3000` | 默认只绑 `127.0.0.1`；`.env` 设 `ST_NEWAPI_BIND=0.0.0.0` 放开 |
| 强制环境 | `ST_EDITION=ce`、清空 control-plane/Redis/Celery | CE 模式不可降级 |
| 数据卷 | `ce-data:/data`（输出为 `/data/output`） | 持久化项目数据库、设置和生成媒体 |

## 3. 配置 `.env`

> ⚠️ **密钥类默认值（如 `PROMPT_EXPORT_PASSWORD=change_me`）必须改。** 模型网关见 [模型配置](#模型配置)。

分组（`.env.example` 内有逐项注释）：本地 NewAPI provisioner、参考媒体 OSS relay（OSS_RELAY_*）、Cognee 知识图谱、文本/图片/视频/音频各模型、图像与视频基础参数、UI、输出目录。渠道、网关地址和 token 通过网页保存到 `settings.db`。

### 发布版本与虾导后端

使用 **v2.1.0 官方镜像**时，在 `.env` 中添加或更新：

```dotenv
DRAMACLAW_VERSION=2.1.0
DRAMACLAW_GATEWAY_VERSION=v1.0.0-rc.24-dramaclaw.3
```

这两个版本也是发布版 Compose 当前的默认值；显式指定可明确实际使用的版本。
可以先检查解析出的镜像，此命令不会启动服务：

```bash
docker compose -f docker-compose.release.yml config --images
```

v2.1.0 的发布版和源码 Compose 均默认选择镜像内置的凭据保护版 Codex 0.164.0。
终端环境或 `.env` 中显式设置的 `DRAMACLAW_CHAT_BACKEND` 会覆盖默认值；
若旧配置选择了其他后端，请改为 `codex`。
虾导后端的选择不等于模型网关模式的选择，
「官方／自定义／混合」仍通过网页设置。

源码构建使用本地 checkout 的 Dockerfile 和代码；设置 `DRAMACLAW_VERSION`
不会更新源码或改变其 Codex 固定版本，需要拉取目标代码并重新构建。

### 模型配置

推荐与备选(详见 [配置模型供应商](../getting-started/configuring-models.md)):

- **A. DC 官方 key(推荐)**：默认 compose 已走官方网关。起栈后开 `http://localhost:8080` → 设置 → 模型配置 → 官方渠道 → 粘贴 DC key 保存即用,**无需映射模型**。到 <https://relayclaw.cdnfg.com> 取 key。
- **B. 本地 NewAPI**：内置网关已在运行；到 设置 → 模型配置 → 自定义，点初始化，然后在「本地 NewAPI」页配置上游渠道和模型映射。

本地 NewAPI 需把 DramaClaw 逻辑模型映射到真实上游模型。参考图功能需要 `OSS_RELAY_AK/SK`（纯文本流程可暂不配）。

## 4. 起停

源码构建：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api
docker compose down
```

官方镜像（先按上文指定版本）：

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml ps
docker compose -f docker-compose.release.yml logs -f api
docker compose -f docker-compose.release.yml down
```

两种 Docker 方式的界面均为 `http://localhost:8080`，API 为 `http://localhost:8780`。
源码 Docker 不提供热更新，代码修改后需要重新构建。
需要在宿主机使用 Python/Vite 开发（界面为 `http://localhost:5173`）时，见[安装指南](../getting-started/installation.md)。

## 5. 数据在哪 / 备份、恢复与迁移

- 项目数据库、设置和生成媒体都在命名卷 `ce-data`（容器内 `/data`）；生成媒体固定写入 `/data/output`。删除或重建容器不会删除该卷，只有显式执行 `docker compose down -v` 才会删除。
- 备份数据卷：

```bash
docker run --rm -v dramaclaw-ce_ce-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/ce-data-backup.tar.gz -C /data .
```

（卷名前缀随 compose 项目名，`docker volume ls` 确认实际名。）

- 恢复 / 搬到新机 —— 把 `ce-data-backup.tar.gz` 拷到目标机，反向解回数据卷（`-v` 挂载会在卷不存在时自动创建）：

```bash
docker run --rm -v dramaclaw-ce_ce-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/ce-data-backup.tar.gz -C /data
```

然后照常起服务（`docker compose up -d`）。数据卷备份已包含生成媒体；`.env` 仍需单独备份。

- `newapi-data` 卷存放内置网关的 SQLite 数据库（上游渠道、密钥、token），不可再生——按同样方式备份：

```bash
docker run --rm -v dramaclaw-ce_newapi-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/newapi-data.tgz -C /data .
```

按同样方式恢复到目标卷：

```bash
docker run --rm -v dramaclaw-ce_newapi-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/newapi-data.tgz -C /data
```

## 6. 升级

源码构建（两个 checkout 都拉）：

```bash
git -C ../dramaclaw-gateway pull   # 从旧 checkout 升级后的第一次：git clone https://github.com/dramaclaw/dramaclaw-gateway.git ../dramaclaw-gateway
git pull
docker compose up -d --build
```

`docker compose up -d --build` 会连内置网关一起从 `../dramaclaw-gateway` 重新构建（Go + bun，要几分钟）；想要更新的网关就到那个目录 `git pull`。只改了 DramaClaw 代码时，只重建两个本地服务：`docker compose up -d --build api web`；只改了网关时：`docker compose up -d --build newapi`。

镜像模式：

```bash
# 编辑 .env：DRAMACLAW_VERSION=2.1.0（发布说明要求时同时改 DRAMACLAW_GATEWAY_VERSION）
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
```

升级不会碰你的 `.env`；`ce-data` 与 `newapi-data` 卷原样复用。

创建 GitHub Release 会触发镜像构建，但不会直接更新 `docker-compose.release.yml` 的默认标签。
独立的发行包打包 workflow 在发布 compose 发行包后会创建版本更新 PR，合并后默认值才会改变。
因此每次升级都应在 `.env` 中显式指定目标版本。

如果旧版本曾将媒体写入容器内 `/app/output`，请在启动新版本**之前**运行一次迁移（zip 用户没有 git 仓库，直接从 GitHub 下载 `scripts/migrate_docker_output.py`）：

```bash
git pull
docker compose exec -T api python - < scripts/migrate_docker_output.py
docker compose up -d
```

Windows PowerShell 使用：

```powershell
git pull
Get-Content scripts/migrate_docker_output.py -Raw | docker compose exec -T api python -
docker compose up -d
```

脚本只复制缺失文件，不覆盖、不删除源文件，并在更新项目路径前备份 `projects.db`。只存在于已删除容器层里的文件无法从数据卷恢复。

### 从旧 checkout 升级

`docker-compose.selfhosted.yml` 与 `docker-compose.selfhosted.release.yml` 已移除，改用上面两份文件——服务名与 `ce-data` / `newapi-data` 数据卷不变，已有数据原样复用。

| 以前 | 现在 |
|---|---|
| `docker compose up -d --build`（官方网关，源码） | 同一命令，但要**先** `git clone https://github.com/dramaclaw/dramaclaw-gateway.git ../dramaclaw-gateway`（不想 clone 就在 `.env` 设 `DRAMACLAW_GATEWAY_SRC=https://github.com/dramaclaw/dramaclaw-gateway.git#main`）；现在会连内置网关一起构建（默认只绑本机、闲置待命）。没 clone 会报 `unable to prepare context: path ".../dramaclaw-gateway" not found` |
| `docker compose -f docker-compose.release.yml up -d` | 同一命令；网关镜像为 `claymorelab/dramaclaw-gateway` |
| `docker compose -f docker-compose.selfhosted.yml up -d --build` | 按上一行先 clone 网关，再 `docker compose up -d --build`；`newapi-data` 卷复用，先备份（rc.21 → rc.24 只加表） |
| `docker compose -f docker-compose.selfhosted.release.yml up -d` | 改用 `docker compose -f docker-compose.release.yml up -d`；同上 |
| `.env` 里的 `NEWAPI_BASE_URL` / `NEWAPI_API_KEY` / `ST_*_PORT` / `INSTALL_WORLD` / `NEWAPI_PROVISIONER_ENABLED` | 含义不变，继续生效 |

## 7. 排错

| 现象 | 排查 |
|---|---|
| 容器起不来 | `docker compose logs api`；多半是 `.env` 网关地址/Key 未改或不可达 |
| 8780 端口占用 | 改 compose `ports` 左值，如 `8888:8780` |
| 3000 端口被占用（内置网关起不来） | `.env` 设 `ST_NEWAPI_PORT=<空闲端口>` 后重新启动。该端口默认只绑 `127.0.0.1`；`api` 不再等网关健康，不会被这个卡住。 |
| 模型调用报错 | 确认网关可达、`*_MODEL` 名在网关后台存在 |

## 相关

- [快速开始](../getting-started/quickstart.md) ｜ [配置模型供应商](../getting-started/configuring-models.md)
