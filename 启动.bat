@echo off
title AkiBurger Voice Launcher
echo ============================================
echo   AkiBurger Voice
echo ============================================
echo.

REM ---- auto-detect GPT-SoVITS folder (wildcard, no non-ASCII chars) ----
set "PROJECT_ROOT=D:\Dev\projects\voice-studio"
set "SOVITS_ROOT="
for /d %%i in ("D:\Dev\ai\02_GPT-SoVITS_*") do set "SOVITS_ROOT=%%i\GPT-SoVITS"
if not exist "%SOVITS_ROOT%\api_v2.py" (
    echo [ERROR] Can't find GPT-SoVITS folder under D:\Dev\ai\02_GPT-SoVITS_*
    pause
    exit /b 1
)
set "SOVITS_PY=%SOVITS_ROOT%\..\.venv\Scripts\python.exe"
set "FFMPEG_BIN=D:\Dev\tools\ffmpeg\bin"

set "PATH=%FFMPEG_BIN%;%PATH%"
set "HF_ENDPOINT=https://hf-mirror.com"

echo [1/4] Check engine - port 9880...
netstat -ano | findstr ":9880" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo       engine already running
) else (
    echo       starting engine. first load takes 1-3 min...
    start "GPT-SoVITS Engine" /D "%SOVITS_ROOT%" "%SOVITS_PY%" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
)

echo [2/4] Waiting for engine...
set /a etries=0
:ewait
set /a etries+=1
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "try{(Invoke-WebRequest http://127.0.0.1:9880/docs -UseBasicParsing -TimeoutSec 2).StatusCode}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 goto engine_ready
if %etries% lss 120 goto ewait
echo       engine timeout. check the engine window for errors.
pause
exit /b 1

:engine_ready
echo       engine ready
echo [2.5/4] Attaching trained voice weights...
curl -s "http://127.0.0.1:9880/set_gpt_weights?weights_path=GPT_weights_v2Pro/setsuna_light-e8.ckpt" >nul 2>&1
curl -s "http://127.0.0.1:9880/set_sovits_weights?weights_path=SoVITS_weights_v2Pro/setsuna_light_e6_s1086.pth" >nul 2>&1
echo       weights attached (setsuna_light e6 / e8)

echo [3/4] Start backend - port 8017...
netstat -ano | findstr ":8017" | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo       backend already running
) else (
    start "AkiBurger Voice Backend" /D "%PROJECT_ROOT%" "%SOVITS_PY%" src\backend\app.py
)

echo [4/4] Waiting for backend...
set /a tries=0
:wait
set /a tries+=1
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try{(Invoke-WebRequest http://127.0.0.1:8017/api/health -UseBasicParsing -TimeoutSec 2).StatusCode}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 goto ready
if %tries% lss 30 goto wait
echo       backend timeout. check the windows that opened for errors.
pause
exit /b 1

:ready
echo.
echo ============================================
echo   Opening http://127.0.0.1:8017/static/index.html
echo ============================================
start http://127.0.0.1:8017/static/index.html
echo.
echo Closing this window does NOT stop the services.
pause
