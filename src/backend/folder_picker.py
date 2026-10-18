# -*- coding: utf-8 -*-
"""
文件夹选择：因为这是本机应用，后端可以弹出 Windows 原生的"选择文件夹"对话框，
把用户选中的路径返回给网页。

实现要点（P1 修复）：
- PowerShell 5.1 的 stdout 是系统 OEM/GBK 编码，中文路径按 UTF-8 解码会变乱码
  （之前选"雪菜"目录会被当成取消），所以**不用 stdout 传结果**，
  而是让 PowerShell 把路径写进一个 UTF-8 临时文件，Python 再读文件。
- 对话框用一个置顶隐藏窗体做 owner，保证出现在最前面。
"""
import os
import subprocess
import tempfile
import threading
from pathlib import Path

_PS_TEMPLATE = r"""
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择音频文件夹（里面放 ogg / wav / flac / mp3 等）'
$dlg.ShowNewFolderButton = $false
$ok = $dlg.ShowDialog($owner)
if ($ok -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) {
    [System.IO.File]::WriteAllText('__OUT_FILE__', $dlg.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))
}
$owner.Dispose()
"""

_lock = threading.Lock()


def pick_folder(timeout: int = 300) -> dict:
    """
    弹出文件夹选择框，返回 {"path": 选中路径 或 ""}。
    用户取消就返回空字符串；出错时带 error 字段。
    """
    if os.environ.get("ABV_PICKER_TEST") == "1":
        return {"path": ""}
    if not _lock.acquire(blocking=False):
        return {"path": "", "busy": True, "message": "已经有一个选择框开着，先选完那个"}

    fd, out_path = tempfile.mkstemp(prefix="abv_pick_", suffix=".txt")
    os.close(fd)
    try:
        os.unlink(out_path)  # 让 PowerShell 自己创建，避免空文件被误读
    except OSError:
        pass

    try:
        ps = _PS_TEMPLATE.replace("__OUT_FILE__", str(Path(out_path).as_posix()))
        r = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", ps],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
        if os.path.exists(out_path):
            raw = Path(out_path).read_text(encoding="utf-8")
            path = raw.strip().strip('"')
            if path and os.path.isdir(path):
                return {"path": path}
            if path:
                return {"path": "", "error": f"选中的路径不存在：{path}"}
        # 没有输出文件 = 取消，或者脚本失败
        if r.returncode != 0:
            err = (r.stderr or "").strip().splitlines()
            msg = err[-1] if err else f"PowerShell 退出码 {r.returncode}"
            return {"path": "", "error": msg[:200]}
        return {"path": ""}
    except subprocess.TimeoutExpired:
        return {"path": "", "error": "选择超时（5 分钟没选）"}
    except Exception as e:
        return {"path": "", "error": str(e)[:200]}
    finally:
        try:
            if os.path.exists(out_path):
                os.unlink(out_path)
        except OSError:
            pass
        _lock.release()
