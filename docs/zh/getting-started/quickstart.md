<!-- lang-switch -->
[English](../../en/getting-started/quickstart.md) · **简体中文**

# 快速开始

> 本地跑起 DramaClaw,产出第一个结果。

DramaClaw 是社区版(CE),单机运行、无需 PostgreSQL / Redis。默认 `docker compose` 起三个服务:`api`(创作后端,:8780)、`newapi`(内置网关,切到自定义/本地 + 官方混合模式前闲置)、`web`(浏览器界面,:8080);模型默认走 **DramaClaw 官方网关(RelayClaw)**,填一个 DC key 即用。

## 前置

- Docker(Desktop 或 Engine),支持 `docker compose`。
- 一个 **DC key** —— 到 <https://relayclaw.cdnfg.com> 注册 / 购买；也可以改用 CE 随附的本地 NewAPI。

## 步骤

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
# 免构建：docker compose -f docker-compose.release.yml up -d   # 拉已发布镜像，不需要 clone 网关

# 4. 确认已起
docker compose ps   # api、newapi、web 均应 running
```

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
