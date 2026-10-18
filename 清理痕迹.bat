@echo off
chcp 65001 >nul
title AkiBurger Voice - Cleanup
echo ============================================
echo   AkiBurger Voice - Cleanup
echo ============================================
echo.
echo This removes generated data only. Original audio files are NOT touched.
echo.
echo   [1] outputs\         - all synthesized audio (regenerable)
echo   [2] data\ref\        - reference audio + text map (moved to trash)
echo   [3] data\setsuna\wav - imported training wavs (moved to trash)
echo.

set "ROOT=%~dp0"
set "TRASH=%ROOT%data\_trash\cleanup_%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%"
set "TRASH=%TRASH: =0%"

set /p doOutputs="[1/3] Delete all files in outputs\ ? (y/N): "
set /p doRef="[2/3] Move data\ref to trash ? (y/N): "
set /p doWav="[3/3] Move data\setsuna\wav to trash ? (y/N): "

echo.
if /i "%doOutputs%"=="y" (
    echo Cleaning outputs\ ...
    if exist "%ROOT%outputs" (
        for /d %%d in ("%ROOT%outputs\*") do rd /s /q "%%d" 2>nul
        del /q "%ROOT%outputs\*" >nul 2>&1
    )
    echo Done.
)

if /i "%doRef%"=="y" (
    echo Moving data\ref to trash ...
    if exist "%ROOT%data\ref" (
        if not exist "%TRASH%" mkdir "%TRASH%" >nul 2>&1
        move "%ROOT%data\ref" "%TRASH%\ref" >nul 2>&1
        if exist "%ROOT%data\ref" echo WARNING: data\ref still exists, close the app and retry.
    )
    echo Done.
)

if /i "%doWav%"=="y" (
    echo Moving data\setsuna\wav to trash ...
    if exist "%ROOT%data\setsuna\wav" (
        if not exist "%TRASH%" mkdir "%TRASH%" >nul 2>&1
        move "%ROOT%data\setsuna\wav" "%TRASH%\wav" >nul 2>&1
        if exist "%ROOT%data\setsuna\wav" echo WARNING: wav folder still exists, close the app and retry.
    )
    echo Done.
)

echo.
if exist "%TRASH%" echo Removed items were moved to: %TRASH%
echo Nothing was sent to git. Check with: git status
echo.
pause
