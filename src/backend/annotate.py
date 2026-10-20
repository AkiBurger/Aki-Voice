# -*- coding: utf-8 -*-
"""
标注：查看 / 修改每段音频对应的文本。

数据来源是清洗后的清单（识别 + 清洗的结果），
界面里可以逐条试听、改文本、保存。
改完的文本直接写回文件，训练时用到的就是改后的版本。
"""
import json
import os
import threading
from datetime import datetime
from pathlib import Path

import project_paths
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = project_paths.dataset_dir(create=True)
WAV_DIR = DATA_DIR / "wav"
_DATASET, _MAIN_LIST, _CLEAN_LIST = project_paths.list_paths()
LIST_FILE = _CLEAN_LIST or (DATA_DIR / f"{DATA_DIR.name}_clean.list")
BACKUP_DIR = DATA_DIR / "list_backups"
_file_lock = threading.Lock()


def _parse_line(line: str):
    parts = line.rstrip("\n").split("|")
    if len(parts) != 4:
        return None
    return {"wav": parts[0], "spk": parts[1], "lang": parts[2], "text": parts[3]}


def load_entries() -> dict:
    """读取所有标注条目。"""
    entries = []
    if LIST_FILE.exists():
        for i, line in enumerate(LIST_FILE.read_text(encoding="utf-8").splitlines()):
            item = _parse_line(line)
            if not item:
                continue
            p = Path(item["wav"])
            exists = p.exists()
            dur = None
            if exists:
                try:
                    import soundfile as sf
                    info = sf.info(str(p))
                    dur = round(info.frames / info.samplerate, 2)
                except Exception:
                    dur = None
            entries.append({
                "id": i,
                "name": p.name,
                "wav": item["wav"],
                "existed": exists,
                "duration": dur,
                "text": item["text"],
                "text_len": len(item["text"]),
            })
    return {
        "file": str(LIST_FILE),
        "count": len(entries),
        "entries": entries,
    }


def save_text(wav_path: str, text: str) -> dict:
    """改一条的文本，写回 list 文件。"""
    text = (text or "").strip()
    if not LIST_FILE.exists():
        raise FileNotFoundError("还没有标注文件")
    # 竖线和换行都会破坏 .list 的单行格式
    if "|" in text:
        raise ValueError("文本里不能有 | 符号")
    if "\n" in text or "\r" in text:
        raise ValueError("文本里不能有换行")

    with _file_lock:
        lines = LIST_FILE.read_text(encoding="utf-8").splitlines()
        hit = False
        out = []
        for line in lines:
            item = _parse_line(line)
            if item and item["wav"] == wav_path:
                out.append(f"{item['wav']}|{item['spk']}|{item['lang']}|{text}")
                hit = True
            else:
                out.append(line)
        if not hit:
            raise KeyError("找不到这条标注")

        # 备份一次，改坏了能找回
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        (BACKUP_DIR / f"{LIST_FILE.stem}_{stamp}.list").write_text(
            LIST_FILE.read_text(encoding="utf-8"), encoding="utf-8")
        # 只保留最近 10 份备份
        backups = sorted(BACKUP_DIR.glob("*.list"))
        for old in backups[:-10]:
            old.unlink(missing_ok=True)

        # 先写临时文件再原子替换，中途崩溃不会截断整个标注
        tmp = LIST_FILE.with_name(LIST_FILE.name + ".tmp")
        tmp.write_text("\n".join(out), encoding="utf-8")
        os.replace(tmp, LIST_FILE)
    return {"ok": True, "wav": wav_path, "text": text}


def stats() -> dict:
    """标注概况。"""
    entries = load_entries()["entries"]
    n = len(entries)
    empty = sum(1 for e in entries if not e["text"].strip())
    short = sum(1 for e in entries if 0 < len(e["text"]) < 4)
    long_ = sum(1 for e in entries if len(e["text"]) > 60)
    missing = sum(1 for e in entries if not e["existed"])
    return {
        "count": n,
        "empty": empty,
        "short": short,
        "long": long_,
        "missing_audio": missing,
    }
