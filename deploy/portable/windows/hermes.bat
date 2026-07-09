@echo off
rem hermes-agent shim for the DramaClaw portable build.
rem uv pip install --target 生成的 bin\hermes 入口会写死打包机 Python 路径,
rem 移动到用户机器后不可用;此 shim 始终经包内 Python 以模块方式启动。
rem 打包时置于 runtime\hermes\ 下(与 hermes 依赖环境同目录)。
setlocal
set "HROOT=%~dp0"
set "PYTHONPATH=%HROOT%"
set "PYTHONUTF8=1"
"%HROOT%..\python\python.exe" -c "import sys; from hermes_cli.main import main; sys.exit(main())" %*
endlocal
