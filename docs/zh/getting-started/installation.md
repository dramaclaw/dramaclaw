<!-- lang-switch -->
[English](../../en/getting-started/installation.md) · **简体中文**

# 安装指南

> 在 macOS / Windows / Linux 上装好 DramaClaw CE 的运行环境。只想最快跑起来,直接看 [快速开始](quickstart.md);本篇覆盖各平台前置与本地开发两种装法。

DramaClaw CE 是单机服务,**无需 PostgreSQL / Redis**。Docker 起 `api` + 内置 `newapi` 网关 + `web`;模型默认走 DramaClaw 官方网关 RelayClaw,在设置页切到自定义模式后走内置网关。本机不跑模型,普通机器即可。

## 两种装法选一

| 方式 | 适合 | 前置 |
|---|---|---|
| **Docker(推荐)** | 部署、试用、生产自托管 | 只需 Docker;ffmpeg 等都在镜像里 |
| **本地开发(uv)** | 改代码、调试 | Python 3.11–3.12、uv、Node.js/pnpm、ffmpeg(自行安装) |

> ffmpeg/ffprobe 是**系统依赖**,CE 不分发其二进制(原因见 [ADR-0002](../../adr/0002-ffmpeg-system-dependency.md))。Docker 镜像已自带;本地开发需自己装,见 [ffmpeg 指南](../guides/ffmpeg.md)。

---

## A. Docker(推荐)

前置:Docker + `docker compose`。

| 平台 | 安装 |
|---|---|
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/)(Apple Silicon 与 Intel 均可) |
| **Windows** | Docker Desktop,启用 **WSL2** 后端(Settings → General → Use WSL2) |
| **Linux** | Docker Engine + `docker-compose-plugin`(各发行版包管理器) —— Docker Compose **≥ 2.24**(`docker compose version` 确认;compose 文件用了 `env_file` 长语法) |

装好后，选择**官方镜像**或**源码构建**。使用 v2.1.0 官方镜像不需要克隆网关源码；
按[快速开始的方式 A](quickstart.md)指定 `DRAMACLAW_VERSION=2.1.0`
和 `DRAMACLAW_GATEWAY_VERSION=v1.0.0-rc.24-dramaclaw.3`。

需要构建本地代码时：

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
git clone https://github.com/dramaclaw/dramaclaw-gateway.git   # 内置网关，从 ../dramaclaw-gateway 构建
cd dramaclaw
cp .env.example .env        # 至少把 PROMPT_EXPORT_PASSWORD 改成非默认值
docker compose up -d --build    # 用两个 checkout 从源码构建 api、web 与网关
```

源码 Docker 不是热更新。修改代码后用 `docker compose up -d --build api web`
重新构建；只改网关时重建 `newapi`。

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

前端还需要 Node.js 和 pnpm；pnpm 版本以 `frontend/package.json` 的声明为准。
只安装 Python 只能运行 API，不能启动 Vite 开发界面。

虾导使用 Codex。`scripts/start-ce.sh` 会根据宿主机平台，自动下载公开的
**DramaClaw 凭据保护版 Codex 0.164.0**，支持 macOS Apple Silicon/Intel 和
Linux x64/ARM64，不需要私有源码仓库权限。首次下载约 250–310 MB，需安装 curl
以及 `shasum`（macOS）或 `sha256sum`（Linux）。
脚本先核对固定的 SHA256，再检查版本；文件缓存到 `runtime/codex/bin/`，后续启动
校验通过便直接复用，也遵循 `NOVELVIDEO_RUNTIME_DIR` / `NOVELVIDEO_DATA_ROOT` 自定义目录。
此脚本不支持 Windows 原生启动，请使用 WSL2 或 Docker。

### 2. 装依赖并启动

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

cp .env.example .env && $EDITOR .env     # 修改 PROMPT_EXPORT_PASSWORD；模型渠道与 Key 通过网页设置

scripts/start-ce.sh
```

浏览器打开 `http://localhost:5173`，这是支持热更新的 Vite 开发界面；
API 为 `http://localhost:8780`。脚本安装依赖后同时启动前后端，Ctrl+C 停止二者。
`.env` 中保持 `DRAMACLAW_CHAT_BACKEND=codex`；旧配置若指定其他后端，脚本会提示修改，
不会静默切换。

如果需要分开管理 API 和前端，先准备同一套运行时再启动 API
（单独运行下载脚本时读取已导出的环境变量，不读取 `.env`）：

```bash
uv sync --group dev
CODEX_BIN="$(bash scripts/setup-codex.sh)" &&
  CODEX_BIN="$CODEX_BIN" DRAMACLAW_CHAT_BACKEND=codex \
    uv run --no-sync novelvideo api --host 127.0.0.1 --port 8780
```

在另一个终端进入仓库根目录，启动前端：

```bash
cd frontend && pnpm install && pnpm dev --host 127.0.0.1 --port 5173
```

若已有配套运行时，可在 `.env` 设置 `CODEX_BIN=/absolute/path/to/codex-dramaclaw`，
或在单独运行下载脚本前导出该变量，以跳过下载。手动指定的文件由使用者管理：脚本检查
能否执行，但不能据此证明它带有凭据保护补丁，请勿用官方原版 Codex CLI 替代。
下载或校验失败时，脚本会在启动服务前退出，不会回退到其他后端。

v2.1.0 Docker 构建已内置凭据保护版 Codex 0.164.0。源码和发布版 Compose 均默认选择 Codex；
如显式设置 `DRAMACLAW_CHAT_BACKEND`，请保持为 `codex`。
上面本地 Python 命令中的 `CODEX_BIN` 是宿主机路径，不是容器内路径。
CE 默认 `ST_EDITION=ce`、免登录单本地用户、任务进程内 inline 执行(无 Ray/Redis/Celery)。

### 3. 验证

```bash
curl http://localhost:8780/api/v1/config   # 返回 200 即正常
```

### 4. 网关（仅自定义 / 本地 + 官方混合模式需要）

官方模式什么都不用再跑。另外两种模式下，API 需要一个跑在 `127.0.0.1:3000` 的网关（`.env` 里 `NEWAPI_ADMIN_BASE_URL` 的默认值），且它的 SQLite 文件在 `./state/newapi/one-api.db`，设置页的「初始化」写的就是这个文件。用发布镜像并把这个目录挂进去：

```bash
mkdir -p state/newapi
docker run -d --name dramaclaw-gateway -p 127.0.0.1:3000:3000 \
  -v "$PWD/state/newapi:/data" \
  claymorelab/dramaclaw-gateway:v1.0.0-rc.24-dramaclaw.3
```

或者在旁边的 `dramaclaw-gateway` checkout 里构建并用 `SQLITE_PATH` 指向该文件来启动。模式配置见[配置模型供应商](configuring-models.md)。

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
