<!-- lang-switch -->
[English](../../en/guides/self-hosting.md) · **简体中文**

# 自托管手册（Docker）

> 用 Docker 部署、配置、升级、备份 DramaClaw CE。

CE 三个容器：`api` + `newapi`（内置 DramaClaw 网关，切到自定义/本地 + 官方混合模式前闲置）+ `web`，**无 PostgreSQL / 无 Redis / 无 Celery**（`ST_EDITION=ce`，任务在进程内 inline 执行）。模型默认走 DramaClaw 官方网关。

## 1. 前置

- Docker + `docker compose`。
- Docker Compose ≥ 2.24（`docker compose version` 确认）。
- 资源：建议 ≥ 2 vCPU / 4GB（不含模型推理，推理走外部网关）。
- 一个 DC key（默认官方网关 RelayClaw,见 <https://relayclaw.cdnfg.com>），或自己的 OpenAI 兼容网关。

## 2. 拿到 compose 与配置

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw
cp .env.example .env
```

`docker-compose.yml` 的关键点（已为你定好，无需改）：

| 项 | 值 | 说明 |
|---|---|---|
| 服务 | `api` + `newapi` + `web` | 无 PG/Redis；`newapi` 是内置网关 |
| 镜像 | `${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/...` | 默认拉 Docker Hub；`.env` 设 `DRAMACLAW_IMAGE_PREFIX` 切到 ACR 镜像（只有钉 tag） |
| 版本 | `DRAMACLAW_VERSION`（api/web）、`DRAMACLAW_GATEWAY_VERSION` | 默认 `latest` / 文件里写死的网关 tag |
| 端口 | `8780:8780` | REST API |
| 强制环境 | `ST_EDITION=ce`、清空 control-plane/Redis/Celery | CE 模式不可降级 |
| 数据卷 | `ce-data:/data`（输出为 `/data/output`） | 持久化项目数据库、设置和生成媒体 |

## 3. 配置 `.env`

> ⚠️ **密钥类默认值（如 `PROMPT_EXPORT_PASSWORD=change_me`）必须改。** 模型网关见 [模型配置](#模型配置)。

分组（`.env.example` 内有逐项注释）：本地 NewAPI provisioner、参考媒体 OSS relay（OSS_RELAY_*）、Cognee 知识图谱、文本/图片/视频/音频各模型、图像与视频基础参数、UI、输出目录。渠道、网关地址和 token 通过网页保存到 `settings.db`。

### 模型配置

推荐与备选(详见 [配置模型供应商](../getting-started/configuring-models.md)):

- **A. DC 官方 key(推荐)**：默认 compose 已走官方网关。起栈后开 `http://localhost:8080` → 设置 → 模型配置 → 官方渠道 → 粘贴 DC key 保存即用,**无需映射模型**。到 <https://relayclaw.cdnfg.com> 取 key。
- **B. 本地 NewAPI**：内置网关已在运行；到 设置 → 模型配置 → 自定义，点初始化，然后在「本地 NewAPI」页配置上游渠道和模型映射。

本地 NewAPI 需把 DramaClaw 逻辑模型映射到真实上游模型。参考图功能需要 `OSS_RELAY_AK/SK`（纯文本流程可暂不配）。

## 4. 起停

```bash
docker compose up -d             # 启动（首次拉镜像）
docker compose ps                # 状态
docker compose logs -f api       # 日志
docker compose down              # 停止（保留数据卷）
```

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

compose 文件只拉已发布镜像，升级 = 改版本号：

```bash
# 编辑 .env：DRAMACLAW_VERSION=2.1.0（发布说明要求时同时改 DRAMACLAW_GATEWAY_VERSION）
docker compose pull
docker compose up -d
```

升级不会碰你的 `.env`；`ce-data` 与 `newapi-data` 卷原样复用。旧 `docker-compose.selfhosted*.yml` 用户：升级前先备份 `newapi-data`，网关镜像跨多个版本，首启会迁移 SQLite 结构。

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

想从源码构建？运行 `scripts/build_images.sh` 并在 `.env` 写 `DRAMACLAW_VERSION=dev`。

## 7. 排错

| 现象 | 排查 |
|---|---|
| 容器起不来 | `docker compose logs api`；多半是 `.env` 网关地址/Key 未改或不可达 |
| 8780 端口占用 | 改 compose `ports` 左值，如 `8888:8780` |
| 3000 端口被占用（内置网关起不来，`api` 等它健康） | `.env` 设 `ST_NEWAPI_PORT=<空闲端口>` 后重新 `docker compose up -d` |
| 模型调用报错 | 确认网关可达、`*_MODEL` 名在网关后台存在 |

## 相关

- [快速开始](../getting-started/quickstart.md) ｜ [配置模型供应商](../getting-started/configuring-models.md)
