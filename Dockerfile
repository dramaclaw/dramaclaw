FROM rust:1.95-bookworm AS codex-builder

# The Codex 0.149 runtime logs the full turn metadata map
# to logs_2.sqlite. DramaClaw carries per-turn gateway credentials and control
# capabilities there, so the stock binary is not safe for a shared home-node
# App Server. Build the official 0.149.0 tagged runtime and redact only
# Debug/log output; the original values still reach the Responses request.
ARG CODEX_REPO="https://github.com/openai/codex.git"
ARG CODEX_REF="758ef40f50c1a458425c7cfbf1eb12cbc07af0b0"
WORKDIR /opt/codex-src
RUN git init \
    && git remote add origin "$CODEX_REPO" \
    && git fetch --depth 1 origin "$CODEX_REF" \
    && git checkout --detach FETCH_HEAD \
    && git rev-parse HEAD > /opt/codex-runtime.sha
COPY deploy/codex/0.149.0-redact-turn-metadata.patch /tmp/codex-turn-metadata.patch
# The official release tag changes workspace.package.version to 0.149.0
# without rewriting Cargo.lock's local workspace package versions. Cargo must
# perform that metadata-only lock refresh; external dependency pins remain
# those committed in the release tag.
RUN git apply --check /tmp/codex-turn-metadata.patch \
    && git apply /tmp/codex-turn-metadata.patch \
    && cd codex-rs \
    && cargo test -p codex-protocol debug_redacts_responses_api_client_metadata_values \
    && cargo build --release -p codex-cli --bin codex \
    && strip target/release/codex \
    && target/release/codex --version

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
    HERMES_CLI_PATH=/usr/local/bin/hermes \
    CODEX_BIN=/usr/local/bin/codex-dramaclaw \
    HOME=/home/dramaclaw

COPY --from=codex-builder /opt/codex-src/codex-rs/target/release/codex /usr/local/bin/codex-dramaclaw
COPY --from=codex-builder /opt/codex-runtime.sha /opt/codex-runtime.sha

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN groupadd --system --gid 10001 dramaclaw \
    && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/dramaclaw dramaclaw
COPY pyproject.toml uv.lock README.md ./
# license 正文按 REUSE 惯例只存于 LICENSES/(pyproject license-files 指向它),
# hatchling 构建 wheel 时需要这份文件在上下文中。
COPY LICENSES NOTICE ./
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
# The SDK declares its stock runtime as a dependency. Remove that unused
# binary so an operator cannot bypass CODEX_BIN and re-enable metadata logs.
# uv.lock contains the pinned Codex Python SDK as a Git source. Keep git in
# this build layer only; it is not needed by the running application.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git; \
    if [ "$INSTALL_WORLD" = "1" ]; then \
        apt-get install -y --no-install-recommends nodejs npm; \
        npm install -g @playcanvas/splat-transform; \
        uv sync --frozen --no-dev --extra world \
          --no-install-package openai-codex-cli-bin; \
    else \
        uv sync --frozen --no-dev \
          --no-install-package openai-codex-cli-bin; \
    fi; \
    mkdir -p /data; \
    apt-get purge -y git; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

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
    chown -R dramaclaw:dramaclaw /data /home/dramaclaw; \
    apt-get purge -y git; apt-get autoremove -y

ENV PATH="/app/.venv/bin:/usr/local/bin:$PATH"

# Hermes and the API never need root at runtime. Compose may still override
# the user explicitly, but the image itself is safe-by-default.
USER dramaclaw:dramaclaw

EXPOSE 8780
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8780/api/v1/config', timeout=2).status == 200 else 1)"

CMD novelvideo api --host 0.0.0.0 --port 8780
