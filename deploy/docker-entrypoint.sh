#!/bin/sh
# CE 容器入口:**仅当选定 Hermes 聊天后端时**才先跑 Hermes 沙箱启动门,再 exec 真正的
# 服务命令("$@" 来自 Dockerfile CMD)。
#
# 沙箱门约束的只有 Hermes worker;codex/claude 等其它后端、以及迁移/诊断/覆盖 CMD 的
# 运维命令都与它无关,不能被一个 Hermes 专属的 gate 全局挡住。尤其是 Linux 沙箱默认
# 不激活(SUPERTALE_LINUX_SANDBOX 未设,见 sandbox_wrap._wrap_linux / #346 P1②),若无条件
# 跑门,EE/production 配 DRAMACLAW_CHAT_BACKEND=codex 也会在 API 启动前被误 fail-close。
set -e

# 解析有效聊天后端,镜像 novelvideo.chat.service._chat_backend 的偏好判定:
# DRAMACLAW_CHAT_BACKEND → SUPERTALE_CHAT_BACKEND → 默认 hermes(全部小写、去空白)。
# 只判偏好,不做可用性探测——门要不要跑取决于"选没选 Hermes",而非 Hermes 是否装好。
_backend="${DRAMACLAW_CHAT_BACKEND:-${SUPERTALE_CHAT_BACKEND:-hermes}}"
_backend="$(printf '%s' "$_backend" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[ -n "$_backend" ] || _backend="hermes"

if [ "$_backend" = "hermes" ]; then
    # 门(deploy/hermes_sandbox_selfcheck.py)以本进程运行用户执行,走 worker 完全相同的
    # 代码路径判断"这台宿主上 Hermes 沙箱是否真的建得起来",退出码即"是否放行启动":
    #   0    → 沙箱可用,或 CE 单租户允许无沙箱降级(脚本内已大声告警)→ 继续启动;
    #   非 0 → EE/production 下沙箱不可用,fail-close 拒绝启动(容器带该码退出)。
    python /app/deploy/hermes_sandbox_selfcheck.py
    # `set -e`:门非 0 时容器已带该码退出;走到这里说明门放行(exit 0)。
fi

exec "$@"
