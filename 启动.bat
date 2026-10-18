@echo off
REM ============================================================
REM  AkiBurger Voice - legacy launcher (compatibility only)
REM  Prefer: AkiBurgerVoice.exe or the desktop shortcut
REM  This script just calls the new exe launcher.
REM ============================================================
cd /d "%~dp0"
if exist "%~dp0AkiBurgerVoice.exe" (
    start "" "%~dp0AkiBurgerVoice.exe"
) else (
    echo [ERROR] AkiBurgerVoice.exe not found in %~dp0
    echo Run launcher\build.bat to rebuild it.
    pause
)
