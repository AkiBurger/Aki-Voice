@echo off
REM ============================================================
REM  Rebuild AkiBurgerVoice.exe from launcher.cs
REM  Requires .NET Framework 4.x csc.exe (built into Windows)
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

echo Compiling launcher.cs ...
"%CSC%" /nologo /target:winexe /optimize+ "/out:..\AkiBurgerVoice.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll launcher.cs
if errorlevel 1 (
    echo [ERROR] compile failed
    pause
    exit /b 1
)
echo Done: ..\AkiBurgerVoice.exe
pause
