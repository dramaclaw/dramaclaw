<!-- lang-switch -->
[English](../../en/guides/troubleshooting.md) · **简体中文**

# 排错

> 自托管 DramaClaw CE 时的常见故障与排查。先看日志:`docker compose logs -f api`,或本地开发时看 `novelvideo api` 的终端输出。

## 启动类

| 现象 | 排查 |
|---|---|
| **容器起不来 / 立即退出** | 查看 `docker compose logs api`，按启动日志定位配置、端口或数据卷问题。 |
| **`8780` 端口被占用** | 改 compose `ports` 左值,如 `8888:8780`;或停掉占用进程(`lsof -i :8780`)。 |
| **健康检查一直 unhealthy** | 探活打 `/api/v1/config`;若 API 自身报错,看启动日志定位真正异常。 |
| **本地开发起不来:Python 版本** | 需 **3.11–3.12**(`>=3.11,<3.13`)。`uv python pin 3.12` 或装对应版本后 `uv sync`。 |

## 模型 / 网关类

| 现象 | 排查 |
|---|---|
| **模型调用全报错** | 在「设置 → 模型配置」确认当前渠道已配置；官方渠道检查 DC key，本地 NewAPI 检查服务、runtime token 和上游渠道。 |
| **某个环节报"模型不存在"** | 本地 NewAPI 中没有对应逻辑模型映射，或目标渠道未启用。详见[配置模型供应商](../getting-started/configuring-models.md)。 |
| **文本模型超时** | 调大 `NEWAPI_TEXT_TIMEOUT_SECONDS`(默认 120);内网网关被系统代理拦截时设 `NEWAPI_TEXT_TRUST_ENV=false`。 |
| **参考图功能不可用** | 需配 `OSS_RELAY_AK/SK`;纯文本→成片流程可不配。 |

## 媒体 / ffmpeg 类

| 现象 | 排查 |
|---|---|
| **合成阶段报找不到 ffmpeg** | 本地开发需自行装 ffmpeg(Docker 已自带);或用 `FFMPEG_PATH` 指定路径。见 [ffmpeg 指南](ffmpeg.md)。 |
| **合成失败,提示编码器不可用** | 默认编码 `libx264`(H.264),你的 ffmpeg build 须包含它;或改 `VIDEO_CODEC`。 |
| **成片黑屏 / 时长异常** | 多为上游图片/音频产物缺失;回看前序环节日志,确认素材已生成。 |

## 数据 / 升级类

| 现象 | 排查 |
|---|---|
| **重建后数据没了** | 数据在命名卷 `ce-data`(容器内 `/data`)。`docker compose down` 保留卷,**别加 `-v`**(会删卷)。备份见 [自托管手册](self-hosting.md#5-数据在哪--备份)。 |
| **升级后报配置错误** | 当前由源码构建:`git pull` 后 `docker compose up -d --build`;对照新版 `.env.example` 补齐新增变量。 |

## world 特性(3DGS/SHARP)类

| 现象 | 排查 |
|---|---|
| **报 `FileNotFoundError` 指向 `BuilderGPT/...`** | 这些重特性脚本不在 CE 精简包内,纯文本→成片不需要;走 3D/体素流程才需补齐。 |
| **`uv sync --extra world` 安装失败** | 需用 uv(非 pip)以使依赖 override 生效;GPU 加速需 CUDA 环境,slim/CPU 环境仅 CPU 路径。 |

## 还没解决?

- 用法/想法 → [GitHub Discussions](https://github.com/dramaclaw/dramaclaw/discussions)
- 确认是 Bug → [提交 Bug](https://github.com/dramaclaw/dramaclaw/issues/new?template=bug_report.yml)(附日志、复现步骤、环境)
- 安全问题 → 勿走公开 issue,见 [SECURITY](../../../SECURITY.md)

## 相关

- [安装指南](../getting-started/installation.md) ｜ [快速开始](../getting-started/quickstart.md) ｜ [自托管手册](self-hosting.md)
