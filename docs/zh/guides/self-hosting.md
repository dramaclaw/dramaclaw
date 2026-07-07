<!-- lang-switch -->
[English](../../en/guides/self-hosting.md) · **简体中文**

# 自托管手册（Docker）

> 用 Docker 部署、配置、升级、备份 DramaClaw CE。

CE 默认两个容器：`api` + `web`，**无 PostgreSQL / 无 Redis / 无 Celery**（`ST_EDITION=ce`，任务在进程内 inline 执行）。模型默认走 DramaClaw 官方网关；想纯本地自建网关,用 `docker-compose.selfhosted.yml`(多一个内置 `newapi` 容器)。

## 1. 前置

- Docker + `docker compose`。
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
| 服务 | `api` + `web` | 无 PG/Redis（自建网关版另起 `newapi`） |
| 端口 | `8780:8780` | REST API |
| 强制环境 | `ST_EDITION=ce`、清空 control-plane/Redis/Celery | CE 模式不可降级 |
| 数据卷 | `ce-data:/data`（`NOVELVIDEO_DATA_ROOT=/data`） | 项目数据持久化 |

## 3. 配置 `.env`

> ⚠️ **密钥类默认值（如 `PROMPT_EXPORT_PASSWORD=change_me`）必须改。** 模型网关见 [模型配置](#模型配置)。

分组（`.env.example` 内有逐项注释）：网关（NEWAPI_*）、参考媒体 OSS relay（OSS_RELAY_*）、Cognee 知识图谱、文本/图片/视频/音频各模型、图像与视频基础参数、UI、输出目录。

### 模型配置

推荐与备选(详见 [配置模型供应商](../getting-started/configuring-models.md)):

- **A. DC 官方 key(推荐)**：默认 compose 已走官方网关。起栈后开 `http://localhost:8080` → 设置 → 模型配置 → 官方渠道 → 粘贴 DC key 保存即用,**无需映射模型**。到 <https://relayclaw.cdnfg.com> 取 key。
- **B. 自带网关(BYO)**：在官方渠道面板或 `.env` 填自己的网关:

```bash
NEWAPI_BASE_URL=https://你的网关/v1
NEWAPI_API_KEY=...
PROMPT_EXPORT_PASSWORD=...        # 默认 change_me，部署务必覆盖
```

- **C. 纯本地内置 newapi**：改用 `docker compose -f docker-compose.selfhosted.yml up`,到 `:3000` 配上游。

B/C 需把约 30 个 `*_MODEL` 逻辑名在网关后台配齐或逐项改名。参考图功能需要 `OSS_RELAY_AK/SK`(纯文本流程可暂不配)。

## 4. 起停

```bash
docker compose up -d --build     # 启动（首次构建）
docker compose ps                # 状态
docker compose logs -f api       # 日志
docker compose down              # 停止（保留数据卷）
```

## 5. 数据在哪 / 备份、恢复与迁移

- 项目数据在命名卷 `ce-data`（容器内 `/data`），输出在 `NOVELVIDEO_OUTPUT_DIR`（默认 `output`）。
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

然后照常起服务（`docker compose -f docker-compose.selfhosted.yml up -d`）。若要一并带上已生成的媒体与配置，把 `output` 目录（`NOVELVIDEO_OUTPUT_DIR`）和 `.env` 也拷过去。

## 6. 升级

> 🚧 当前由源码构建，升级 = 拉新代码后重建：

```bash
git pull
docker compose up -d --build
```

正式发布后改为**拉取钉版本的已发布镜像** + env-sync（升级保留你的自定义 `.env` 值）——见发行规格落地后更新本节。

## 7. 排错

| 现象 | 排查 |
|---|---|
| 容器起不来 | `docker compose logs api`；多半是 `.env` 网关地址/Key 未改或不可达 |
| 8780 端口占用 | 改 compose `ports` 左值，如 `8888:8780` |
| 模型调用报错 | 确认网关可达、`*_MODEL` 名在网关后台存在 |

## 相关

- [快速开始](../getting-started/quickstart.md) ｜ [配置模型供应商](../getting-started/configuring-models.md)
