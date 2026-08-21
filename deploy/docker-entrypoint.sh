#!/bin/sh
# CE 容器入口:先跑 Hermes 沙箱启动门,再 exec 真正的服务命令("$@" 来自 Dockerfile CMD)。
#
# 沙箱门(deploy/hermes_sandbox_selfcheck.py)以本进程的运行用户执行,走 worker 完全
# 相同的代码路径判断"这台宿主上沙箱是否真的建得起来",退出码即"是否放行启动":
#   0    → 沙箱可用,或 CE 单租户允许无沙箱降级(已在脚本内大声告警)→ 继续启动;
#   非 0 → EE/production 下沙箱不可用,fail-close 拒绝启动(容器直接退出)。
#
# 决策全在 Python 门里(与 sandbox_wrap 同源),这里只按退出码放行/拒绝,不重复判断。
set -e

python /app/deploy/hermes_sandbox_selfcheck.py
# 门通过(exit 0)才会走到这里;非 0 时 `set -e` 已让容器带着该码退出。

exec "$@"
