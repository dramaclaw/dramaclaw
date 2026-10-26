# Codex runtime pin — the single source of truth for every image that ships the
# credential-safe Codex App Server (this file, and downstream images that read
# these two lines). The tag encodes <upstream ref[:7]>-p<patch sha256[:8]>; the
# digest pins the exact published index. Bump both lines together.
#
# Why prebuilt: the stock openai/codex 0.149 binary logs the full per-turn
# metadata map (which carries per-turn gateway credentials) to logs_2.sqlite.
# deploy/codex/0.149.0-redact-turn-metadata.patch redacts it and consumes the
# per-turn key as Responses bearer auth. The patched binary is compiled once by
# the maintainers' release pipeline and published to Docker Hub; this image
# only verifies and copies it (tests/test_docker_persistence_config.py keeps the
# tag consistent with the patch file and CODEX_REF).
#
# Platform status: the pinned image above is linux/amd64 only today. Publishing
# an arm64 artifact is a hard prerequisite before this Dockerfile reaches main,
# since release-images.yml builds both platforms.
ARG CODEX_REF="758ef40f50c1a458425c7cfbf1eb12cbc07af0b0"
ARG CODEX_RUNTIME_IMAGE="docker.io/claymorelab/codex-dramaclaw:758ef40-pc9db6e46@sha256:b53773645294faade3dbb397d91efb7110358d55806a9f291c2a409172da30a6"

FROM rust:1.95-bookworm AS vtracer-builder
RUN cargo install --locked --version 1.0.0-alpha.3 vtracer-cli

# Node for the vendored OpenFilm Studio (the 「视频合成与剪辑」 editor). The distro's node is
# older than the vendored server expects; the binary is copied into the final image.
FROM node:22-bookworm-slim AS node-runtime

# Studio's one runtime dependency (playwright-core), installed from the vendored lockfile so
# the version and integrity hash match what was tested. npm is not needed at runtime.
FROM node:22-bookworm-slim AS openfilm-deps
WORKDIR /openfilm
COPY vendor/openfilm/package.json vendor/openfilm/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM ${CODEX_RUNTIME_IMAGE} AS codex-runtime

FROM python:3.12-slim
ARG CODEX_REF
COPY --from=vtracer-builder /usr/local/cargo/bin/vtracer /usr/local/bin/vtracer
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

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
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=codex-runtime /codex /usr/local/bin/codex-dramaclaw
COPY --from=codex-runtime /codex-runtime.sha /opt/codex-runtime.sha
COPY --from=codex-runtime /codex-runtime.json /opt/codex-runtime.json

# ffmpeg for media; bubblewrap (`bwrap`) for the Hermes Linux sandbox — the
# vendored codex-linux-sandbox binary's default pipeline execs system bwrap
# (Landlock is only its --use-legacy-landlock fallback, which we do not use).
# The binary itself is installed further down, per TARGETARCH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# deploy/codex/ is copied again, in full, further down as part of the
# application source (COPY deploy ./deploy); this narrow copy only makes the
# patch file available here, before WORKDIR /app, for the identity check below.
COPY deploy/codex/ /tmp/codex-bom/

# Fail the build (not the container's preflight an hour later) if the prebuilt
# runtime is not the upstream commit this image claims, if its patch does not
# match the one recorded in codex-runtime.json, or if the binary cannot start
# on this base image (shared libraries).
RUN set -eux; \
    test "$(cat /opt/codex-runtime.sha)" = "${CODEX_REF}" \
        || { echo "codex-runtime.sha ($(cat /opt/codex-runtime.sha)) does not match CODEX_REF (${CODEX_REF})" >&2; exit 1; }; \
    want_patch_sha256="$(python3 -c 'import json; print(json.load(open("/opt/codex-runtime.json"))["patch_sha256"])')"; \
    got_patch_sha256="$(sha256sum /tmp/codex-bom/*.patch | cut -d' ' -f1)"; \
    test "$got_patch_sha256" = "$want_patch_sha256" \
        || { echo "codex-runtime patch_sha256 mismatch: codex-runtime.json says $want_patch_sha256, deploy/codex/*.patch hashes to $got_patch_sha256" >&2; exit 1; }; \
    codex-dramaclaw --version

WORKDIR /app

# OpenFilm Studio (the 「视频合成与剪辑」 editor) runs from this tree at request time: the Python
# backend spawns scripts/openfilm_studio/run.mjs with the vendored server and patched UI.
# node_modules comes from the lockfile stage, never from the build context.
COPY --from=openfilm-deps /openfilm/node_modules ./vendor/openfilm/node_modules

# Chromium draws the editor's thumbnails, covers and exports; --with-deps installs its shared
# libraries. The headless shell carries no fonts, so CJK titles and subtitles need Noto.
# PLAYWRIGHT_BROWSERS_PATH is in studio.py's env passthrough; without that the spawned Studio
# would look under $HOME/.cache and silently fall back to a system Chrome this image lacks.
# Kept before the vendor tree so a re-vendored UI does not re-download the browser.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends fonts-noto-cjk; \
    node vendor/openfilm/node_modules/playwright-core/cli.js install --with-deps --only-shell chromium; \
    rm -rf /var/lib/apt/lists/*

COPY vendor/openfilm ./vendor/openfilm
COPY scripts/openfilm_studio ./scripts/openfilm_studio

# Fail the build, not the feature: starts Chromium, boots the vendored Studio and checks that
# the served index loads Dramaclaw's patched chunk.
RUN node scripts/openfilm_studio/smoke.mjs

COPY pyproject.toml uv.lock README.md ./
# license 正文按 REUSE 惯例只存于 LICENSES/(pyproject license-files 指向它),
# hatchling 构建 wheel 时需要这份文件在上下文中。
COPY LICENSES ./LICENSES
COPY NOTICE ./NOTICE
COPY src ./src
COPY .hermes ./.hermes
COPY deploy ./deploy

# Hermes Linux sandbox binary: install the vendored codex-linux-sandbox for
# this image's target arch onto PATH, where sandbox_wrap._wrap_linux looks it
# up (`shutil.which` / /usr/local/bin). TARGETARCH is amd64|arm64 (BuildKit),
# matching deploy/sandbox/linux-{amd64,arm64}/. The `--help` smoke only proves
# the ELF loads (loader/arch OK); it creates no sandbox, so it does not need
# host user namespaces; the worker performs its cached functional probe before
# wrapping a Hermes command.
ARG TARGETARCH
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
    /app/.venv/bin/python -m novelvideo.ladybug_json_extension; \
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
    apt-get purge -y git; apt-get autoremove -y

ENV PATH="/app/.venv/bin:/usr/local/bin:$PATH"

EXPOSE 8780
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8780/api/v1/config', timeout=2).status == 200 else 1)"

CMD ["novelvideo", "api", "--host", "0.0.0.0", "--port", "8780"]
