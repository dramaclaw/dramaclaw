#!/bin/sh
set -eu

companion_entry=${1:-/opt/dramaclaw/org-brand-proxy-server.mjs}
nginx_entrypoint=${2:-/docker-entrypoint.sh}
brand_restart_delay=${ORG_BRAND_RESTART_DELAY_SECONDS:-1}

companion_pid=
nginx_pid=

start_companion() {
    node "$companion_entry" &
    companion_pid=$!
}

start_companion

cleanup() {
    trap - EXIT INT TERM
    if [ -n "${companion_pid:-}" ]; then
        kill "$companion_pid" 2>/dev/null || true
    fi
    if [ -n "${nginx_pid:-}" ]; then
        kill "$nginx_pid" 2>/dev/null || true
    fi
    if [ -n "${companion_pid:-}" ]; then
        wait "$companion_pid" 2>/dev/null || true
    fi
    if [ -n "${nginx_pid:-}" ]; then
        wait "$nginx_pid" 2>/dev/null || true
    fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$nginx_entrypoint" nginx -g "daemon off;" &
nginx_pid=$!

while kill -0 "$nginx_pid" 2>/dev/null; do
    if ! kill -0 "$companion_pid" 2>/dev/null; then
        wait "$companion_pid" 2>/dev/null || true
        companion_pid=
        sleep "$brand_restart_delay"
        if kill -0 "$nginx_pid" 2>/dev/null; then
            start_companion
        fi
    fi
    sleep 0.05
done

set +e
wait "$nginx_pid"
status=$?
set -e
exit "$status"
