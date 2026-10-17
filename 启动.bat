@echo off
chcp 65001 >nul
title AkiBurger Voice 启动器
echo ============================================
echo   AkiBurger Voice
echo ============================================
echo.

set "SOVITS_ROOT=D:\Dev\ai\02_GPT-SoVITS_配音\GPT-SoVITS"
set "SOVITS_PY=D:\Dev\ai\02_GPT-SoVITS_配音\.venv\Scripts\python.exe"
set "PROJECT_ROOT=D:\Dev\projects\voice-studio"
set "FFMPEG_BIN=D:\Dev\tools\ffmpeg\bin"

set "PATH=%FFMPEG_BIN%;%PATH%"
set "HF_ENDPOINT=https://hf-mirror.com"

echo [1/3] 检查声音引擎 (端口 9880)...
netstat -ano | findstr ":9880" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo       引擎已经在运行
) else (
    echo       引擎未运行，正在启动（首次加载模型约需 1~3 分钟）...
    start "GPT-SoVITS 引擎" cmd /k "cd /d %SOVITS_ROOT% && "%SOVITS_PY%" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml"
)

echo [2/3] 启动后端服务 (端口 8017)...
netstat -ano | findstr ":8017" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo       后端已经在运行
) else (
    start "AkiBurger Voice 后端" cmd /k "cd /d %PROJECT_ROOT% && "%SOVITS_PY%" src\backend\app.py"
)

echo [3/3] 等待后端就绪...
set /a tries=0
:wait
set /a tries+=1
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try{(Invoke-WebRequest http://127.0.0.1:8017/api/health -UseBasicParsing -TimeoutSec 2).StatusCode}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 goto ready
if %tries% lss 30 goto wait
echo       后端启动超时，请看弹出的窗口里的报错
pause
exit /b 1

:ready
echo       后端就绪
echo.
echo ============================================
echo   打开界面 http://127.0.0.1:8017/static/index.html
echo ============================================
start http://127.0.0.1:8017/static/index.html
echo.
echo 关闭本窗口不会关掉服务。要停止服务请关掉弹出的那两个黑窗口。
pause
