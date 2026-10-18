# -*- coding: utf-8 -*-
"""
文件夹选择：因为这是本机应用，后端可以弹出 Windows 原生的"选择文件夹"对话框，
把用户选中的路径返回给网页。这样就不用让用户手动复制路径。

实现方式：调 PowerShell 的 FolderBrowserDialog（Windows 自带），
加一个置顶的隐藏窗体做 owner，保证对话框出现在最前面。
"""
import os
import subprocess
import threading

PS_SCRIPT = r"""
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择音频文件夹（里面放 ogg / wav / flac / mp3 等）'
$dlg.ShowNewFolderButton = $false
$ok = $dlg.ShowDialog($owner)
if ($ok -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dlg.SelectedPath
}
$owner.Dispose()
"""

_lock = threading.Lock()


def pick_folder(timeout: int = 300) -> dict:
    """
    弹出文件夹选择框，返回 {"path": 选中路径 或 ""}。
    用户取消就返回空字符串。
    """
    # 测试钩子：不弹窗，直接返回空
    if os.environ.get("ABV_PICKER_TEST") == "1":
        return {"path": ""}
    if not _lock.acquire(blocking=False):
        return {"path": "", "busy": True, "message": "已经有一个选择框开着，先选完那个"}

    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", PS_SCRIPT],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
        lines = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
        path = lines[-1] if lines else ""
        # PowerShell 有时会输出 CLIXML 之类的东西，做一次兜底校验
        if path and not os.path.isdir(path):
            path = ""
        return {"path": path}
    except subprocess.TimeoutExpired:
        return {"path": "", "error": "选择超时（5 分钟没选）"}
    except Exception as e:
        return {"path": "", "error": str(e)[:200]}
    finally:
        _lock.release()
