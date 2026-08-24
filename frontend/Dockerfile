# syntax=docker/dockerfile:1.7

# Stage 1: build the SPA.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /app

ARG VITE_APP_VERSION=dev
ENV VITE_APP_VERSION=${VITE_APP_VERSION}

# CE release fallback edition. Edition is normally decided at runtime by the
# backend (GET /api/v1/config); VITE_EDITION only takes effect when that fetch
# fails, so baking =ce makes this CE image fail safe to CE (no EE login wall)
# instead of the EE default. See src/lib/runtime-config.ts fallbackRuntimeConfig().
ARG VITE_EDITION=ce
ENV VITE_EDITION=${VITE_EDITION}

# Use pnpm (matches local dev) instead of npm — a single lockfile as source of
# truth, which removes the npm/pnpm dual-lockfile drift that made `npm ci` fail.
# corepack picks the version pinned in package.json's "packageManager" field.
# pnpm-workspace.yaml is required here: it carries the allowBuilds approvals that
# keep `pnpm install` from erroring on skipped (unneeded) dependency build scripts.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Stage 2: serve via nginx + reverse-proxy /api /static to the backend Service.
FROM nginx:1.27-alpine AS runtime

# Defaults overridable per environment via Helm values -> Deployment env.
ENV BACKEND_HOST=novelvideo-ui-staging \
    BACKEND_PORT=8780 \
    NGINX_ENVSUBST_FILTER="^(BACKEND_HOST|BACKEND_PORT)$"

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
