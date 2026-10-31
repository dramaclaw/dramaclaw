# Codex runtime pin — the single source of truth for every image that ships the
# credential-safe Codex App Server. The fork includes per-turn credential
# redaction and Responses authentication; the old 0.149 patch is historical.
# Pin the fork commit, upstream version and multi-arch index together.
# This published index provides native linux/amd64 and linux/arm64 binaries.
ARG CODEX_REF="27f7ff4d5c458953a9a54d48cc26ef93309cf8c9"
ARG CODEX_VERSION="0.164.0"
ARG CODEX_RUNTIME_IMAGE="docker.io/claymorelab/codex-dramaclaw:27f7ff4@sha256:a1c05773ea6c8449f258e3969fdfcd85649f58d62920f3c48c4fb6206114b856"

FROM rust:1.95-bookworm AS vtracer-builder
RUN cargo install --locked --version 1.0.0-alpha.3 vtracer-cli

FROM ${CODEX_RUNTIME_IMAGE} AS codex-runtime

FROM python:3.12-slim
ARG CODEX_REF
ARG CODEX_VERSION
ARG TARGETARCH
COPY --from=vtracer-builder /usr/local/cargo/bin/vtracer /usr/local/bin/vtracer

# 项目全程用 uv 管理(与 host 一致)。Dockerfile 也用 uv,使 uv.lock 锁版本 +
# [[tool.uv.dependency-metadata]] override(da2 的 torch==2.5.0 冲突、sharp 的 gsplat)
# 生效——pip 不认这些 override,会在 da2/world 解析冲突时 build 失败。
RUN pip install --no-cache-dir uv

ENV ST_EDITION=ce \
    ST_CONTROL_PLANE_DSN= \
    ST_REDIS_URL= \
    ST_CELERY_BROKER_URL= \
    ST_CELERY_RESULT_BACKEND= \
    NOVELVIDEO_DATA_ROOT=/data \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/root/.cache/uv \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    DRAMACLAW_CHAT_BACKEND=codex \
    CODEX_BIN=/usr/local/bin/codex-dramaclaw

COPY --from=codex-runtime /codex /usr/local/bin/codex-dramaclaw
COPY --from=codex-runtime /codex-runtime.sha /opt/codex-runtime.sha
COPY --from=codex-runtime /codex-runtime.json /opt/codex-runtime.json

# Keep the media tools and OS sandbox dependencies independently of the chat
# runtime. Retiring Hermes must not weaken the application's sandbox boundary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# deploy/codex/ is copied again, in full, further down as part of the
# application source (COPY deploy ./deploy); this narrow copy only makes the
# verifier available here, before WORKDIR /app, for the identity check below.
COPY deploy/codex/ /tmp/codex-bom/

# Fail the build (not the container's preflight an hour later) if the prebuilt
# runtime has the wrong fork commit, version, architecture or binary hash.
# Also execute it to catch loader/shared-library failures on the target platform.
RUN set -eux; \
    python3 /tmp/codex-bom/verify_runtime.py \
        --ref "${CODEX_REF}" --version "${CODEX_VERSION}" --arch "${TARGETARCH}"; \
    test "$(codex-dramaclaw --version)" = "codex-cli ${CODEX_VERSION}"

WORKDIR /app
COPY pyproject.toml uv.lock ./

# Cache dependency installation independently of application changes. uv's
# download/build cache belongs to BuildKit, not the distributed image.
ARG INSTALL_WORLD=0
RUN --mount=type=cache,id=dramaclaw-uv-${TARGETARCH},target=/root/.cache/uv,sharing=locked \
    set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git; \
    if [ "$INSTALL_WORLD" = "1" ]; then \
        apt-get install -y --no-install-recommends nodejs npm; \
        npm install -g @playcanvas/splat-transform; \
        uv sync --frozen --no-dev --extra world --no-install-project \
          --no-install-package openai-codex-cli-bin; \
    else \
        uv sync --frozen --no-dev --no-install-project \
          --no-install-package openai-codex-cli-bin; \
    fi; \
    apt-get purge -y git; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

COPY README.md ./
# license 正文按 REUSE 惯例只存于 LICENSES/(pyproject license-files 指向它),
# hatchling 构建 wheel 时需要这份文件在上下文中。
COPY LICENSES ./LICENSES
COPY NOTICE ./NOTICE
COPY src ./src
COPY .hermes ./.hermes
COPY deploy ./deploy

# Preserve the reviewed OS sandbox executable for the target architecture.
# This loader check does not replace runtime isolation and credential gates.
RUN set -eux; \
    sbx="deploy/sandbox/linux-${TARGETARCH}/codex-linux-sandbox"; \
    test -x "$sbx" || { echo "no vendored codex-linux-sandbox for TARGETARCH='${TARGETARCH}'" >&2; exit 1; }; \
    install -m 0755 "$sbx" /usr/local/bin/codex-linux-sandbox; \
    command -v bwrap; \
    codex-linux-sandbox --help >/dev/null

# 资产完整性兜底(等价原 wheel 检查):login 媒体须随 src 带入(.dockerignore 已 ! 放行)。
RUN test -f src/novelvideo/assets/login_bgm.mp3 \
    && test -f src/novelvideo/assets/login_bg_v1.mp4 \
    && test -f src/novelvideo/assets/login_bg_v2.mp4 \
    && test -f src/novelvideo/assets/login_bg_v3.mp4

# 可选 3DGS/SHARP「world」特性。默认精简镜像。INSTALL_WORLD=1 时:
#   - node + @playcanvas/splat-transform(PLY→SOG,MIT)装到 PATH
#   - uv sync --extra world(torch/sharp@apple/ml-sharp/da2/…;经 uv override 去 gsplat
#     + 化解 da2 torch 冲突,与 host `uv sync --extra world` 完全一致)
# 模型权重不烤进镜像:运行时自动下载到可写卷(Apple 研究许可,绝不再分发)。
# 注:slim base 为 CPU;GPU 加速需 CUDA base + nvidia runtime。
# The SDK declares its stock runtime as a dependency. Remove that unused
# binary so an operator cannot bypass CODEX_BIN and re-enable metadata logs.
# Git-backed dependencies were installed in the cached layer above. The
# application sync below keeps the same frozen graph and editable layout.
RUN --mount=type=cache,id=dramaclaw-uv-${TARGETARCH},target=/root/.cache/uv,sharing=locked \
    set -eux; \
    if [ "$INSTALL_WORLD" = "1" ]; then \
        uv sync --frozen --no-dev --extra world \
          --no-install-package openai-codex-cli-bin; \
    else \
        uv sync --frozen --no-dev \
          --no-install-package openai-codex-cli-bin; \
    fi; \
    /app/.venv/bin/python -m novelvideo.ladybug_json_extension; \
    mkdir -p /data

ENV PATH="/app/.venv/bin:/usr/local/bin:$PATH"

# The retired Hermes runtime must not reappear through a dependency or layer.
RUN ! command -v hermes \
    && test ! -e /opt/hermes-agent \
    && /app/.venv/bin/python -c "import importlib.util; assert importlib.util.find_spec('hermes_cli') is None; assert importlib.util.find_spec('acp_adapter') is None"

EXPOSE 8780
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8780/api/v1/config', timeout=2).status == 200 else 1)"

CMD ["novelvideo", "api", "--host", "0.0.0.0", "--port", "8780"]
