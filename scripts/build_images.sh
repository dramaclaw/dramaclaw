#!/usr/bin/env bash
# 本地构建 DramaClaw CE 的 api / web 镜像，供 docker-compose.yml 以 DRAMACLAW_VERSION=<tag> 使用。
# 网关镜像永远拉 claymorelab/dramaclaw-gateway，不在本地构建。
# 用法：scripts/build_images.sh [tag]        默认 tag=dev
#       INSTALL_WORLD=1 scripts/build_images.sh   带 3DGS/SHARP「world」特性（体积大、CPU 版）
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
tag="${1:-dev}"
prefix="${DRAMACLAW_IMAGE_PREFIX:-claymorelab}"
install_world="${INSTALL_WORLD:-0}"

echo "==> building ${prefix}/dramaclaw:${tag} (INSTALL_WORLD=${install_world})"
docker build \
  --build-arg "INSTALL_WORLD=${install_world}" \
  -t "${prefix}/dramaclaw:${tag}" \
  "${root_dir}"

echo "==> building ${prefix}/dramaclaw-frontend:${tag}"
docker build \
  -t "${prefix}/dramaclaw-frontend:${tag}" \
  "${root_dir}/frontend"

cat <<MSG

Done. To run the stack with these images, put this in ${root_dir}/.env:

  DRAMACLAW_VERSION=${tag}

then: docker compose up -d
If your .env sets DRAMACLAW_IMAGE_PREFIX, export the same value before running this script so the tags match.
MSG
