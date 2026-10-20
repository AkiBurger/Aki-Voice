# -*- coding: utf-8 -*-
"""环境自检：检查运行本项目需要的东西是否就位。

用法:
    python tools/check_env.py

只做检查，不修改任何文件。
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src" / "backend"))

try:
    import project_paths
except Exception as exc:  # 路径模块本身有问题时也要给提示
    print("无法加载 src/backend/project_paths.py:", exc)
    raise SystemExit(1)

OK = "  [OK]   "
WARN = "  [WARN] "
FAIL = "  [FAIL] "

results = []


def check(level, name, detail=""):
    results.append(level)
    print(level + name + (("  " + detail) if detail else ""))


def main():
    print("AkiBurger Voice 环境检查")
    print("项目目录:", PROJECT_ROOT)
    print()

    # Python
    version = sys.version_info
    if version >= (3, 10):
        check(OK, "Python", f"{version.major}.{version.minor}.{version.micro}")
    else:
        check(FAIL, "Python", "需要 3.10 或更高版本")

    # GPT-SoVITS
    sovits = project_paths.sovits_root()
    if sovits and (sovits / "api_v2.py").exists():
        check(OK, "GPT-SoVITS", str(sovits))
        for sub in ("SoVITS_weights_v2Pro", "GPT_weights_v2Pro"):
            path = sovits / sub
            if path.exists():
                check(OK, "  权重目录", str(path))
            else:
                check(WARN, "  权重目录", f"不存在: {path}")
    else:
        check(FAIL, "GPT-SoVITS", "没找到含 api_v2.py 的目录，设置 ABV_SOVITS_ROOT")

    # ffmpeg
    ffmpeg = project_paths.ffmpeg_dir() / "ffmpeg.exe"
    if ffmpeg.exists():
        check(OK, "ffmpeg", str(ffmpeg))
    else:
        found = shutil.which("ffmpeg")
        check(OK if found else FAIL, "ffmpeg", found or f"未找到，设置 ABV_FFMPEG_DIR（当前查找 {ffmpeg}）")

    # HuggingFace 缓存
    hf = project_paths.hf_cache()
    if hf.exists():
        check(OK, "HuggingFace 缓存", str(hf))
    else:
        check(WARN, "HuggingFace 缓存", f"不存在: {hf}")

    # Fun-ASR（可选，训练前识别才需要）
    snapshot = os.environ.get("ABV_FUNASR_SNAPSHOT", "").strip()
    if snapshot and Path(snapshot).exists():
        check(OK, "Fun-ASR 模型", snapshot)
    else:
        check(WARN, "Fun-ASR 模型", "未设置 ABV_FUNASR_SNAPSHOT（只影响识别素材）")

    # 显卡
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        )
        line = (out.stdout or "").strip().splitlines()
        if out.returncode == 0 and line:
            check(OK, "NVIDIA 显卡", line[0])
        else:
            check(WARN, "NVIDIA 显卡", "nvidia-smi 没有返回信息")
    except FileNotFoundError:
        check(FAIL, "NVIDIA 显卡", "没有找到 nvidia-smi，训练和合成需要 NVIDIA 显卡")
    except Exception as exc:
        check(WARN, "NVIDIA 显卡", str(exc))

    # 数据目录
    data_dir = project_paths.dataset_dir()
    if data_dir.exists():
        check(OK, "数据目录", str(data_dir))
    else:
        check(WARN, "数据目录", f"还不存在，首次导入时创建: {data_dir}")

    print()
    if FAIL in results:
        print("有必须处理的项，先按上面提示补齐。")
        print("安装说明: docs/install.md")
        return 1
    print("必要的组件都在。启动引擎和后端后，可以打开 http://127.0.0.1:8017")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
