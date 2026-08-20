FROM python:3.12-slim

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
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    HERMES_CLI_PATH=/root/.local/bin/hermes

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
# license 正文按 REUSE 惯例只存于 LICENSES/(pyproject license-files 指向它),
# hatchling 构建 wheel 时需要这份文件在上下文中。
COPY LICENSES ./LICENSES
COPY src ./src
COPY .hermes ./.hermes
COPY deploy ./deploy

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
ARG INSTALL_WORLD=0
RUN set -eux; \
    if [ "$INSTALL_WORLD" = "1" ]; then \
        apt-get update; \
        apt-get install -y --no-install-recommends git nodejs npm; \
        rm -rf /var/lib/apt/lists/*; \
        npm install -g @playcanvas/splat-transform; \
        uv sync --frozen --no-dev --extra world; \
    else \
        uv sync --frozen --no-dev; \
    fi; \
    mkdir -p /data

# Hermes comes from this project's own fork, always. A PyPI release cannot
# serve this image: it keeps the same version string as the fork and then drops
# the `_meta` extension the per-turn credential travels in, so every turn fails
# closed and reports it as a connection error. There is no version to pin here
# — which upstream release the fork carries is a property of the branch.
# Hermes comes from this project's own fork, cloned and installed editable.
#
# Not from PyPI: a release keeps the same version string as the fork and then
# drops the `_meta` extension the per-turn credential travels in, so every turn
# fails closed and reports it as a connection error. Not as a wheel either —
# upstream refuses to build one on purpose ("distributed via the shell
# installer, Docker image, or Nix"), and an editable install from a clone is
# the supported path that a pinned commit can actually use.
#
# HERMES_REF is a branch by default and resolves to whatever it points at when
# the image is built. Pass a commit sha to make a build reproducible.
ARG HERMES_REPO="https://github.com/dramaclaw/hermes-agent.git"
ARG HERMES_REF="brainclaw/evidence-plane"
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git; \
    rm -rf /var/lib/apt/lists/*; \
    git clone --depth 1 --branch "$HERMES_REF" "$HERMES_REPO" /opt/hermes-agent \
      || { git clone "$HERMES_REPO" /opt/hermes-agent; git -C /opt/hermes-agent checkout "$HERMES_REF"; }; \
    HERMES_SHA="$(git -C /opt/hermes-agent rev-parse HEAD)"; \
    echo "$HERMES_SHA" > /opt/hermes-agent.sha; \
    rm -rf /opt/hermes-agent/.git; \
    uv pip install --system -e "/opt/hermes-agent[acp]"; \
    python3 deploy/patch_hermes_acp_toolsets.py; \
    hermes --version; \
    python3 deploy/verify_hermes_fork.py; \
    apt-get purge -y git; apt-get autoremove -y

ENV PATH="/app/.venv/bin:/root/.local/bin:$PATH"

EXPOSE 8780
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8780/api/v1/config', timeout=2).status == 200 else 1)"

CMD novelvideo api --host 0.0.0.0 --port 8780
