# -*- coding: utf-8 -*-
"""项目路径：数据目录、GPT-SoVITS、ffmpeg、HF 缓存。

默认按项目所在位置推断，也支持环境变量覆盖：
  ABV_PROJECT_ROOT / ABV_AI_ROOT / ABV_SOVITS_ROOT / ABV_FFMPEG_DIR / ABV_HF_CACHE
数据目录优先用 data/voice；没有的话找 data 下第一个带 train.py 或 *_clean.list 的目录。
"""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = PROJECT_ROOT / "data"


def _env(name: str):
    value = os.environ.get(name, "").strip()
    return Path(value) if value else None


def ai_root() -> Path:
    return _env("ABV_AI_ROOT") or (PROJECT_ROOT.parent.parent / "ai")


def dataset_dir(create: bool = False) -> Path:
    preferred = DATA_ROOT / "voice"
    if preferred.exists():
        return preferred
    if DATA_ROOT.exists():
        for item in sorted(DATA_ROOT.iterdir()):
            if not item.is_dir():
                continue
            if (item / "train.py").exists() or any(item.glob("*_clean.list")):
                return item
    if create:
        preferred.mkdir(parents=True, exist_ok=True)
    return preferred


def list_paths():
    """返回 (数据目录, 主清单, 清洗清单)；找不到的项是 None。"""
    folder = dataset_dir()
    main = clean = None
    if folder.exists():
        for path in sorted(folder.glob("*.list")):
            if path.name.endswith("_clean.list"):
                clean = path
            elif main is None:
                main = path
    return folder, main, clean


def sovits_root():
    env = _env("ABV_SOVITS_ROOT")
    if env and (env / "GPT_SoVITS" / "api_v2.py").exists():
        return env
    base = ai_root()
    if base.exists():
        for item in sorted(base.glob("*GPT-SoVITS*")):
            if (item / "GPT-SoVITS" / "api_v2.py").exists():
                return item / "GPT-SoVITS"
    return None


def ffmpeg_dir() -> Path:
    return _env("ABV_FFMPEG_DIR") or (ai_root().parent / "tools" / "ffmpeg" / "bin")


def hf_cache() -> Path:
    return _env("ABV_HF_CACHE") or (ai_root().parent / "cache" / "huggingface" / "hub")
