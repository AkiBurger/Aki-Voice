@echo off
chcp 65001 >nul
title AkiBurger Voice 清理工具
echo ============================================
echo   AkiBurger Voice · 清理生成痕迹
echo ============================================
echo.
echo 这个脚本会删除：
echo   - outputs\ 里的全部合成音频
echo   - data\ref\ 里复制的参考音频
echo.
echo 不会动：源代码、设计文档、git 记录、引擎。
echo.
set /p confirm="确认要清理吗？输入 y 回车（其他键取消）: "
if /i not "%confirm%"=="y" (
    echo 已取消，什么都没删。
    pause
    exit /b 0
)

set "ROOT=%~dp0"

echo.
echo [1/2] 清空 outputs ...
if exist "%ROOT%outputs" (
    del /s /q "%ROOT%outputs\*" >nul 2>&1
    for /d %%d in ("%ROOT%outputs\*") do rd /s /q "%%d" 2>nul
)
echo [2/2] 清空 data\ref ...
if exist "%ROOT%data\ref" (
    del /s /q "%ROOT%data\ref\*" >nul 2>&1
)

echo.
echo 完成。outputs 和 data\ref 已清空。
echo.
echo 提示：如果还要清 git 里的历史提交，那是另一个操作，
echo 告诉我（AI）说「重置 git 历史」即可。
pause
