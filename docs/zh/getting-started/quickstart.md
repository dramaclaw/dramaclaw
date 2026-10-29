<!-- lang-switch -->
[English](../../en/getting-started/quickstart.md) · **简体中文**

# 快速开始

> 本地跑起 DramaClaw,产出第一个结果。

DramaClaw 是社区版(CE),单机运行、无需 PostgreSQL / Redis。默认 `docker compose` 起三个服务:`api`(创作后端,:8780)、`newapi`(内置网关,切到自定义/本地 + 官方混合模式前闲置)、`web`(浏览器界面,:8080);模型默认走 **DramaClaw 官方网关(RelayClaw)**,填一个 DC key 即用。

## 前置

- Docker(Desktop 或 Engine),支持 `docker compose`。
- 一个 **DC key** —— 到 <https://relayclaw.cdnfg.com> 注册 / 购买；也可以改用 CE 随附的本地 NewAPI。

## 方式 A：使用 v2.1.3 官方镜像（免构建）

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw
cp .env.example .env
```

编辑 `.env`：将 `PROMPT_EXPORT_PASSWORD` 改成非默认值，并添加或更新：

```dotenv
DRAMACLAW_VERSION=2.1.3
DRAMACLAW_GATEWAY_VERSION=v1.0.0-rc.24-dramaclaw.3
```

发布版 Compose 默认使用镜像内置的凭据保护版 Codex 0.164.0 虾导。
如果终端环境或 `.env` 已指定其他后端，请改为 `DRAMACLAW_CHAT_BACKEND=codex`。
虾导后端的选择与「官方／自定义／混合」模型网关模式是两回事。

```bash
docker compose -f docker-compose.release.yml config --images
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml ps
```

这两个版本也是 Compose 的默认值；显式指定版本可以明确每次升级的目标。
此方式不需要克隆网关源码，也不需要加 `--build`。

## 方式 B：用 Docker 构建本地源码

```bash
# 1. 取得代码 —— DramaClaw 和内置网关并排放
git clone https://github.com/dramaclaw/dramaclaw.git
git clone https://github.com/dramaclaw/dramaclaw-gateway.git
cd dramaclaw

# 2. 准备配置
cp .env.example .env
#    打开 .env,至少把 PROMPT_EXPORT_PASSWORD 改成非默认值。
#    模型渠道和 key 在下一步通过网页配置，不写入 .env。

# 3. 启动 —— 起 api / newapi / web 三个服务
docker compose up -d --build   # 从源码构建 api、web（本仓）与网关（../dramaclaw-gateway）

# 4. 确认已起
docker compose ps   # api、newapi、web 均应 running
```

源码版 Compose 默认使用 Codex。构建使用本地 checkout 的代码，
不是 `DRAMACLAW_VERSION` 指定的发布镜像。修改代码后要重新构建，不是热更新：

```bash
docker compose up -d --build api web
# 只修改网关时：docker compose up -d --build newapi
```

需要在宿主机使用 Python/Vite 开发和前端热更新时，见[安装指南](installation.md)。

## 填入 DC key(必做一次)

1. 浏览器打开 **`http://localhost:8080`** —— 这就是 DramaClaw 的界面。
2. 进入设置 → **模型配置 → 官方渠道**。网关地址已预填 `https://relayclaw.cdnfg.com/v1`。
3. **粘贴你的 DC key**,点「保存并启用」。立即可用,**无需映射任何模型**(RelayClaw 后台已配齐)。

> CE 默认免登录、单本地用户(`ST_EDITION=ce`,compose 已强制)。REST API 在 `http://localhost:8780`(浏览器只与 `web` 通信,它再反代到 `api`)。

## 想使用自己的模型渠道？

内置 NewAPI 随 `docker compose up -d` 一起启动。在「设置 → 模型配置 → 自定义」中初始化并填写上游 key、保存模型映射。地址和 runtime token 会写入本机 `settings.db`，不写入 `.env`。详见[配置模型供应商](configuring-models.md)。

## 下一步

- 完整部署/升级/备份:[自托管手册](../guides/self-hosting.md)
- 接入自己的模型:[配置模型供应商](configuring-models.md)
