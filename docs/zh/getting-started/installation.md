<!-- lang-switch -->
[English](../../en/getting-started/installation.md) · **简体中文**

# 安装指南

> 在 macOS / Windows / Linux 上装好 DramaClaw CE 的运行环境。只想最快跑起来,直接看 [快速开始](quickstart.md);本篇覆盖各平台前置与本地开发两种装法。

DramaClaw CE 是单机服务,**无需 PostgreSQL / Redis**。Docker 起 `api` + 内置 `newapi` 网关 + `web`;模型默认走 DramaClaw 官方网关 RelayClaw,在设置页切到自定义模式后走内置网关。本机不跑模型,普通机器即可。

## 两种装法选一

| 方式 | 适合 | 前置 |
|---|---|---|
| **Docker(推荐)** | 部署、试用、生产自托管 | 只需 Docker;ffmpeg 等都在镜像里 |
| **本地开发(uv)** | 改代码、调试 | Python 3.11–3.12、uv、ffmpeg(自行安装) |

> ffmpeg/ffprobe 是**系统依赖**,CE 不分发其二进制(原因见 [ADR-0002](../../adr/0002-ffmpeg-system-dependency.md))。Docker 镜像已自带;本地开发需自己装,见 [ffmpeg 指南](../guides/ffmpeg.md)。

---

## A. Docker(推荐)

前置:Docker + `docker compose`。

| 平台 | 安装 |
|---|---|
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/)(Apple Silicon 与 Intel 均可) |
| **Windows** | Docker Desktop,启用 **WSL2** 后端(Settings → General → Use WSL2) |
| **Linux** | Docker Engine + `docker-compose-plugin`(各发行版包管理器) —— Docker Compose **≥ 2.24**(`docker compose version` 确认;compose 文件用了 `env_file` 长语法) |

装好后:

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw
cp .env.example .env        # 至少把 PROMPT_EXPORT_PASSWORD 改成非默认值
docker compose up -d --build    # 从源码构建 api、web 与内置网关
# 免构建：docker compose -f docker-compose.release.yml up -d   # 拉已发布镜像
```

起好后浏览器打开 **`http://localhost:8080`**(应用界面);REST API 在 `http://localhost:8780`。进入设置 → 模型配置 → 官方渠道,粘贴 DC key 保存即用。完整步骤见 [快速开始](quickstart.md),起停/备份见 [自托管手册](../guides/self-hosting.md)。

> Windows 用户在 **WSL2 终端**里 clone 与运行(放到 Linux 文件系统下,别放 `/mnt/c/...`),避免卷挂载性能与换行问题。

---

## B. 本地开发(uv + Python 3.11–3.12)

### 1. 装前置

| 平台 | Python 3.11/3.12 | uv | ffmpeg |
|---|---|---|---|
| **macOS** | `brew install python@3.12` | `brew install uv` | `brew install ffmpeg` |
| **Windows** | [python.org](https://www.python.org/downloads/) 或 `winget install Python.Python.3.12` | `winget install astral-sh.uv` | `winget install Gyan.FFmpeg`(或用 WSL2 走 Linux 流程) |
| **Linux(Debian/Ubuntu)** | `apt install python3.12` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `apt install ffmpeg` |

> Python 必须落在 **3.11–3.12**(`requires-python = ">=3.11,<3.13"`)。uv 会按 `uv.lock` 锁定依赖版本。

### 2. 装依赖并启动

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

uv sync                                  # 按 uv.lock 装依赖到 .venv
cp .env.example .env && $EDITOR .env     # 填网关与 Key

uv run novelvideo api --host 0.0.0.0 --port 8780
```

CE 默认 `ST_EDITION=ce`、免登录单本地用户、任务进程内 inline 执行(无 Ray/Redis/Celery)。

### 3. 验证

```bash
curl http://localhost:8780/api/v1/config   # 返回 200 即正常
```

---

## 可选:world 特性(3DGS / SHARP 深度)

体素/全景转 3D 等重特性在可选 `world` extra 里,**需 GPU 与额外工具链**,默认不装:

```bash
uv sync --extra world                       # 装 torch / ml-sharp / da2 等
npm install -g @playcanvas/splat-transform  # PLY→SOG 压缩工具
```

Docker:`INSTALL_WORLD=1 docker compose up -d --build`。slim base 为 CPU;GPU 加速需 CUDA base + nvidia runtime。模型权重运行时自动下载,不烤进镜像。

> 不做 3D/体素相关流程可忽略本节,纯文本→成片不需要它。

---

## 下一步

- 跑通第一个结果:[快速开始](quickstart.md)
- 接入自己的模型网关:[配置模型供应商](configuring-models.md)
- 装/校验 ffmpeg:[ffmpeg 指南](../guides/ffmpeg.md)
- 遇到问题:[排错](../guides/troubleshooting.md)
