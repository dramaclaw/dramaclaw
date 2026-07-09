@echo off
rem DramaClaw portable test build - start script
setlocal
set "ROOT=%~dp0"
rem UTF-8 mode: Chinese-locale Windows defaults to GBK; project data is UTF-8
set "PYTHONUTF8=1"

rem --- CE standalone mode (mirror docker-compose.release.yml) ---
set "ST_EDITION=ce"
set "ST_CONTROL_PLANE_DSN="
set "ST_REDIS_URL="
set "ST_CELERY_BROKER_URL="
set "ST_CELERY_RESULT_BACKEND="
set "NEWAPI_PROVISIONER_ENABLED=true"
if not defined NEWAPI_BASE_URL set "NEWAPI_BASE_URL=https://relayclaw.cdnfg.com/v1"

rem --- data under %LOCALAPPDATA%\DramaClaw (survives package deletion) ---
set "DATA_DIR=%LOCALAPPDATA%\DramaClaw"
if not exist "%DATA_DIR%\state" mkdir "%DATA_DIR%\state"
if not exist "%DATA_DIR%\output" mkdir "%DATA_DIR%\output"
set "NOVELVIDEO_DATA_ROOT=%DATA_DIR%"
set "NOVELVIDEO_STATE_DIR=%DATA_DIR%\state"
set "NOVELVIDEO_OUTPUT_DIR=%DATA_DIR%\output"

rem --- bundled runtime ---
rem pywin32 依赖 .pth 注入子目录;--target 布局需显式列出(portalocker Win32 锁需要)
set "PYTHONPATH=%ROOT%runtime\env;%ROOT%runtime\env\win32;%ROOT%runtime\env\win32\lib;%ROOT%runtime\env\Pythonwin"
set "PATH=%ROOT%runtime\ffmpeg;%PATH%"
rem world(3DGS/SHARP) PLY->SOG needs the bundled Node CLI; task errors clearly if absent
if exist "%ROOT%runtime\node\splat-transform.cmd" (
  set "ST_SPLAT_TRANSFORM_BIN=%ROOT%runtime\node\splat-transform.cmd"
  set "PATH=%ROOT%runtime\node;%PATH%"
)
set "DRAMACLAW_FRONTEND_DIST=%ROOT%frontend"
set "DRAMACLAW_CHAT_BACKEND=hermes"
set "HERMES_CLI_PATH=%ROOT%runtime\hermes\hermes.bat"

echo Starting DramaClaw at http://127.0.0.1:8780 ...
echo (first start may take ~1 minute; browser opens when ready)
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{$r=Invoke-WebRequest -Uri http://127.0.0.1:8780/api/v1/config -TimeoutSec 2 -UseBasicParsing;if($r.StatusCode -eq 200){Start-Process http://127.0.0.1:8780;break}}catch{};Start-Sleep 2}"
"%ROOT%runtime\python\python.exe" -c "import sys; from novelvideo.cli import app; sys.exit(app())" api --host 127.0.0.1 --port 8780
endlocal
