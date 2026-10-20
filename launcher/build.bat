@echo off
REM ============================================================
REM  Rebuild AkiBurgerVoice.exe from launcher.cs
REM  Requires .NET Framework 4.x csc.exe (built into Windows)
REM  Embeds: PerMonitorV2 manifest + 4 baked art backgrounds + display font subset
REM ============================================================
setlocal
cd /d "%~dp0"

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    echo [ERROR] csc.exe not found. .NET Framework 4.x is required.
    pause
    exit /b 1
)

set "MANIFEST=assets\app.manifest"
set "FONT=assets\ZCOOLQingKeHuangYou-subset.ttf.gz"
set "BG_IDLE=assets\bg-idle.jpg"
set "BG_THINKING=assets\bg-thinking.jpg"
set "BG_HAPPY=assets\bg-happy.jpg"
set "BG_SAD=assets\bg-sad.jpg"
set "APP_ICON=assets\app.ico"
set "APP_ICON_PNG=assets\app-icon.png"

for %%F in ("%MANIFEST%" "%FONT%" "%BG_IDLE%" "%BG_THINKING%" "%BG_HAPPY%" "%BG_SAD%" "%APP_ICON%" "%APP_ICON_PNG%") do (
    if not exist "%%~F" (
        echo [ERROR] missing resource: %%~F
        if /i "%%~xF"==".gz" echo Regenerate it with: python assets\make-font-subset.py
        pause
        exit /b 1
    )
)

echo Compiling launcher.cs ...
"%CSC%" /nologo /target:winexe /optimize+ ^
 /out:"..\AkiBurgerVoice.exe" ^
 /r:System.Windows.Forms.dll /r:System.Drawing.dll ^
 "/win32manifest:%MANIFEST%" ^
 "/win32icon:%APP_ICON%" ^
 "/resource:%BG_IDLE%,AkiBurgerVoice.bg.idle.jpg" ^
 "/resource:%BG_THINKING%,AkiBurgerVoice.bg.thinking.jpg" ^
 "/resource:%BG_HAPPY%,AkiBurgerVoice.bg.happy.jpg" ^
 "/resource:%BG_SAD%,AkiBurgerVoice.bg.sad.jpg" ^
 "/resource:%FONT%,AkiBurgerVoice.ZCOOL.ttf.gz" ^
 "/resource:%APP_ICON%,AkiBurgerVoice.app.ico" ^
 "/resource:%APP_ICON_PNG%,AkiBurgerVoice.appicon.png" ^
 launcher.cs
if errorlevel 1 (
    echo [ERROR] compile failed
    pause
    exit /b 1
)
echo Done: ..\AkiBurgerVoice.exe
pause
