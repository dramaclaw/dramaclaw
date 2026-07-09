#!/bin/sh
# hermes-agent shim for the DramaClaw portable build.
# uv pip install --target 生成的 bin/hermes 入口 shebang 写死打包机 Python
# 路径,移动到用户机器后不可用;此 shim 始终经包内 Python 以模块方式启动。
# 打包时置于 runtime/hermes/ 下(与 hermes 依赖环境同目录)。
HROOT="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$HROOT"
export PYTHONUTF8=1
exec "$HROOT/../python/bin/python3" -c "import sys; from hermes_cli.main import main; sys.exit(main())" "$@"
