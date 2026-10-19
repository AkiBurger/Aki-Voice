# -*- coding: utf-8 -*-
"""
训练素材处理：扫描 → 导入（统一转 16k 单声道 wav）→ ASR 识别 + 清洗。
"""
import os
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data" / "setsuna"
WAV_DIR = DATA_DIR / "wav"
ASR_SCRIPT = DATA_DIR / "batch_asr.py"
CLEAN_SCRIPT = DATA_DIR / "clean_data.py"
FFMPEG = r"D:\Dev\tools\ffmpeg\bin\ffmpeg.exe"

AUDIO_EXT = {".ogg", ".wav", ".flac", ".mp3", ".m4a", ".aac", ".opus", ".wma"}

_state = {
    "kind": "",          # import | prepare
    "running": False,
    "done": 0,
    "total": 0,
    "message": "",
    "error": "",
    "started_at": None,
    "finished_at": None,
}
_logs = deque(maxlen=200)
_task_lock = threading.Lock()      # 导入/识别互斥
_lock = threading.Lock()


def _say(msg: str):
    with _lock:
        _logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def _resolve(path_str: str) -> Path:
    p = Path(path_str.strip().strip('"'))
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    return p


def scan_source(path_str: str) -> dict:
    """扫描一个文件夹里的音频：数量 + 总时长（不出声，只用元数据）。"""
    p = _resolve(path_str)
    if not p.exists():
        raise FileNotFoundError(f"路径不存在：{p}")
    if not p.is_dir():
        raise NotADirectoryError(f"不是文件夹：{p}")

    files = [f for f in p.rglob("*") if f.is_file() and f.suffix.lower() in AUDIO_EXT]
    total_sec = 0.0
    durations = []
    try:
        import soundfile as sf
        for f in files[:3000]:
            try:
                info = sf.info(str(f))
                d = info.frames / info.samplerate
                durations.append(d)
                total_sec += d
            except Exception:
                pass
    except Exception:
        pass

    return {
        "path": str(p),
        "file_count": len(files),
        "scanned": len(durations),
        "total_min": round(total_sec / 60, 1),
        "avg_sec": round(total_sec / len(durations), 1) if durations else 0,
        "already_imported": len(list(WAV_DIR.glob("*.wav"))) if WAV_DIR.exists() else 0,
    }


def _convert_one(src: Path, dst: Path) -> bool:
    """用 ffmpeg 转成 16k 单声道 wav。"""
    try:
        cmd = [FFMPEG, "-y", "-loglevel", "error", "-i", str(src),
               "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst)]
        r = subprocess.run(cmd, capture_output=True, timeout=120)
        return r.returncode == 0 and dst.exists() and dst.stat().st_size > 1000
    except Exception:
        return False


def start_import(path_str: str, max_samples: int = 0) -> dict:
    """把文件夹里的音频导入成训练用的 wav（后台跑）。"""
    # 互斥：扫描文件之前就要占住任务位，否则两个导入能同时开跑
    if not _task_lock.acquire(blocking=False):
        return {"ok": False, "message": "有任务在跑，等它结束"}
    try:
        src = _resolve(path_str)
        if not src.is_dir():
            return {"ok": False, "message": f"不是文件夹：{src}"}

        files = [f for f in src.rglob("*") if f.is_file() and f.suffix.lower() in AUDIO_EXT]
        files.sort()
        if not files:
            return {"ok": False, "message": "这个文件夹里没有找到音频文件（支持 ogg/wav/flac/mp3 等）"}
        # max_samples <= 0 表示全部导入（默认）
        if max_samples and int(max_samples) > 0:
            files = files[: int(max_samples)]

        WAV_DIR.mkdir(parents=True, exist_ok=True)
        with _lock:
            _logs.clear()
        _state.update({
            "kind": "import", "running": True, "done": 0, "total": len(files),
            "message": f"开始导入 {len(files)} 段音频", "error": "",
            "started_at": datetime.now().isoformat(timespec="seconds"), "finished_at": None,
        })

        def worker():
            ok = 0
            err = ""
            try:
                for i, f in enumerate(files, 1):
                    dst = WAV_DIR / (f.stem + ".wav")
                    if dst.exists():
                        ok += 1
                    elif _convert_one(f, dst):
                        ok += 1
                    else:
                        _say(f"转换失败: {f.name}")
                    with _lock:
                        _state["done"] = i
                    if i % 20 == 0 or i == len(files):
                        _say(f"导入进度 {i}/{len(files)}，成功 {ok}")
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                _say(f"导入异常：{err}")
            finally:
                with _lock:
                    _state["running"] = False
                    _state["message"] = (f"导入完成：成功 {ok}/{len(files)}" if not err
                                         else f"导入失败：{err}")
                    _state["error"] = err
                    _state["finished_at"] = datetime.now().isoformat(timespec="seconds")
                _say(_state["message"])
                _task_lock.release()

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "message": _state["message"], "total": len(files)}
    except Exception:
        _task_lock.release()
        raise


def is_busy() -> bool:
    """后台任务（导入/识别）是否在跑。"""
    return bool(_state.get("running")) or _task_lock.locked()


def start_prepare() -> dict:
    """识别 + 清洗（后台跑，比较久）。"""
    if not _task_lock.acquire(blocking=False):
        return {"ok": False, "message": "有任务在跑，等它结束"}
    if not WAV_DIR.exists() or not list(WAV_DIR.glob("*.wav")):
        _task_lock.release()
        return {"ok": False, "message": "还没有导入音频，先导入再识别"}

    with _lock:
        _logs.clear()
    _state.update({
        "kind": "prepare", "running": True, "done": 0, "total": 0,
        "message": "正在识别语音（这一步比较久）", "error": "",
        "started_at": datetime.now().isoformat(timespec="seconds"), "finished_at": None,
    })

    def worker():
        py = sys.executable
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        env["PATH"] = r"D:\Dev\tools\ffmpeg\bin;" + env.get("PATH", "")
        list_file = DATA_DIR / "setsuna.list"
        clean_file = DATA_DIR / "setsuna_clean.list"
        old_clean = _read_list(clean_file)      # 用户可能改过的标注
        old_raw = _read_list(list_file)         # 上一轮 ASR 原文（判断哪些是用户手改的）
        # 先备份（识别会全量重写，先留退路）
        backup_dir = DATA_DIR / "list_backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        for f in (list_file, clean_file):
            if f.exists():
                shutil.copy2(f, backup_dir / f"{f.stem}_{stamp}.list")
        _say(f"已备份原有标注到 data/setsuna/list_backups/{stamp}")
        try:
            # 1. ASR
            p = subprocess.Popen([py, "-u", str(ASR_SCRIPT)], cwd=str(PROJECT_ROOT),
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="replace")
            for line in p.stdout:
                line = line.rstrip()
                if line:
                    _say(line)
                import re as _re
                m = _re.search(r"进度\s+(\d+)/(\d+)", line)
                if m:
                    with _lock:
                        _state["done"] = int(m.group(1))
                        _state["total"] = int(m.group(2))
            p.wait()
            if p.returncode != 0:
                raise RuntimeError("语音识别失败，详见日志")

            # 2. 清洗
            with _lock:
                _state["message"] = "正在清洗标注"
            _say("开始清洗标注…")
            p2 = subprocess.run([py, "-u", str(CLEAN_SCRIPT)], cwd=str(PROJECT_ROOT),
                                capture_output=True, text=True, encoding="utf-8", errors="replace")
            for line in (p2.stdout or "").splitlines():
                if line.strip():
                    _say(line)
            if p2.returncode != 0:
                raise RuntimeError("清洗失败，详见日志")

            # 3. 合并：保住用户手改过的文本
            kept = _merge_manual_edits(clean_file, old_clean, old_raw)
            if kept:
                _say(f"已保留 {kept} 条你手动改过的标注")

            with _lock:
                _state["running"] = False
                _state["message"] = f"识别与清洗完成（保留手改标注 {kept} 条），可以开始训练了"
                _state["finished_at"] = datetime.now().isoformat(timespec="seconds")
            _say(_state["message"])
        except Exception as e:
            with _lock:
                _state["running"] = False
                _state["error"] = str(e)
                _state["message"] = f"失败：{e}"
                _state["finished_at"] = datetime.now().isoformat(timespec="seconds")
            _say(_state["message"])
        finally:
            if _task_lock.locked():
                _task_lock.release()

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "message": _state["message"]}


def job_status() -> dict:
    with _lock:
        logs = list(_logs)[-25:]
        return {**_state, "log_tail": logs}


def current_dataset() -> dict:
    """当前已经导入/清洗好的数据。"""
    wavs = list(WAV_DIR.glob("*.wav")) if WAV_DIR.exists() else []
    clean = DATA_DIR / "setsuna_clean.list"
    clean_count = 0
    if clean.exists():
        for line in clean.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            wav_path = line.split("|")[0]
            if Path(wav_path).exists():      # 只算音频还存在的
                clean_count += 1
    return {
        "wav_count": len(wavs),
        "clean_count": clean_count,
        "has_list": clean.exists(),
    }

def list_materials() -> dict:
    """已导入的素材列表（名字/时长/大小）。"""
    import soundfile as sf
    files = []
    total_sec = 0.0
    wavs = sorted(WAV_DIR.glob("*.wav")) if WAV_DIR.exists() else []
    for w in wavs:
        try:
            info = sf.info(str(w))
            dur = round(info.frames / info.samplerate, 2)
            total_sec += dur
        except Exception:
            dur = None
        files.append({
            "name": w.name,
            "duration": dur,
            "size_kb": round(w.stat().st_size / 1024, 1),
        })
    return {
        "count": len(files),
        "total_min": round(total_sec / 60, 1),
        "files": files,
    }


TRASH_DIR = PROJECT_ROOT / "data" / "_trash"


def delete_materials(name: str = "", delete_all: bool = False) -> dict:
    """
    删除已导入素材（按文件名或全部）。
    不会真删：移动到 data/_trash/<时间戳>/，可以用 restore_materials 找回。
    """
    wavs = sorted(WAV_DIR.glob("*.wav")) if WAV_DIR.exists() else []
    if not delete_all and not name:
        raise ValueError("要删哪个？")

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    trash = TRASH_DIR / f"material_{stamp}"
    trash.mkdir(parents=True, exist_ok=True)

    def _safe_target(name_: str) -> Path:
        """只允许删除 wav 目录下的 .wav 文件（防路径穿越/搬走整目录）"""
        if not name_:
            raise ValueError("要删哪个？")
        raw = str(name_).strip().replace("\\", "/")
        if "/" in raw or raw in (".", "..") or raw.startswith("../"):
            raise ValueError("文件名不合法")
        cand = (WAV_DIR / raw)
        try:
            if WAV_DIR.resolve() != cand.resolve().parent:
                raise ValueError("文件名不合法")
        except Exception:
            raise ValueError("文件名不合法")
        if cand.suffix.lower() != ".wav":
            raise ValueError("只能删 .wav 素材")
        if not cand.is_file():
            raise FileNotFoundError(f"找不到文件：{name_}")
        return cand

    targets = wavs if delete_all else [_safe_target(name)]

    removed = 0
    for w in targets:
        if not w.exists():
            if not delete_all:
                raise FileNotFoundError(f"找不到文件：{name}")
            continue
        try:
            shutil.move(str(w), str(trash / w.name))
            removed += 1
        except Exception:
            pass
    if removed == 0 and not delete_all:
        raise FileNotFoundError(f"找不到文件：{name}")

    # 注意：删除是"可恢复"操作（文件进了 _trash），所以不动标注清单。
    # 以前单条删除会调 _prune_lists 把对应行裁掉 —— 恢复素材后文本对不上。
    # 现在标注保持原样：恢复后文本依然能对上；清单里的"已删行"由
    # current_dataset() 按"音频是否存在"过滤，不会算进统计。
    # _prune_lists 保留给 ASR/导入的全量清理用，这里不再调用。

    return {
        "ok": True,
        "removed": removed,
        "remain": len(list(WAV_DIR.glob("*.wav"))) if WAV_DIR.exists() else 0,
        "trash": str(trash),
    }


def _backup_lists() -> None:
    """改动标注清单前先复制一份，保留最近 20 份。"""
    bk = DATA_DIR / "list_backups"
    try:
        bk.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        for name_ in ("setsuna.list", "setsuna_clean.list"):
            src = DATA_DIR / name_
            if src.exists():
                shutil.copy2(src, bk / f"{name_.replace('.list', '')}_{stamp}.list")
        backups = sorted(bk.glob("*.list"))
        for old in backups[:-20]:
            old.unlink(missing_ok=True)
    except Exception:
        pass


def _prune_lists(targets=None) -> int:
    """
    从 setsuna.list / setsuna_clean.list 里删掉音频不存在（或指定 targets）的行。
    targets=None 表示按"文件是否存在"过滤。
    """
    removed = 0
    drop = set()
    if targets:
        drop = {str(Path(t)).lower() for t in targets}
    for name_ in ("setsuna.list", "setsuna_clean.list"):
        lf = DATA_DIR / name_
        if not lf.exists():
            continue
        keep = []
        for line in lf.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            wav_path = line.split("|")[0]
            gone = (str(Path(wav_path)).lower() in drop) if targets else (not Path(wav_path).exists())
            if gone:
                removed += 1
                continue
            keep.append(line)
        lf.write_text("\n".join(keep), encoding="utf-8")
    return removed


def trash_batches() -> list:
    """回收站里有哪些批次（最近的在前）。"""
    if not TRASH_DIR.exists():
        return []
    out = []
    for d in sorted(TRASH_DIR.glob("material_*"), reverse=True):
        if d.is_dir():
            out.append({"batch": d.name, "count": len(list(d.glob("*.wav")))})
    return out


def restore_materials(batch: str = "") -> dict:
    """从回收站恢复素材。batch 留空 = 恢复最近一次。"""
    batches = [b for b in trash_batches() if b["count"] > 0]
    if not batches:
        raise FileNotFoundError("回收站是空的，没有可恢复的素材")
    target = None
    if batch:
        for b in batches:
            if b["batch"] == batch:
                target = TRASH_DIR / b["batch"]
                break
        if target is None:
            raise FileNotFoundError(f"找不到这个批次：{batch}")
    else:
        target = TRASH_DIR / batches[0]["batch"]

    WAV_DIR.mkdir(parents=True, exist_ok=True)
    restored, skipped = 0, 0
    for w in target.glob("*.wav"):
        dst = WAV_DIR / w.name
        # 目标已存在就跳过，不覆盖用户后来导入的新音频
        if dst.exists():
            skipped += 1
            continue
        try:
            shutil.move(str(w), str(dst))
            restored += 1
        except Exception:
            pass
    try:
        if not any(target.iterdir()):
            target.rmdir()
    except Exception:
        pass
    msg = f"已恢复 {restored} 段素材"
    if skipped:
        msg += f"，{skipped} 段因同名已存在被跳过"
    return {"ok": True, "restored": restored, "skipped": skipped, "message": msg,
            "skipped_reason": "同名文件已存在，未覆盖（保留现有点）" if skipped else "",
            "remain": len(list(WAV_DIR.glob("*.wav")))}

def _read_list(path):
    """读 .list 文件 → {wav 路径: 文本}"""
    out = {}
    try:
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                parts = line.split("|")
                if len(parts) == 4:
                    out[parts[0]] = parts[3]
    except Exception:
        pass
    return out


def _merge_manual_edits(clean_file, old_clean, old_raw):
    """
    识别清洗后，把用户手动改过的标注合并回来。
    判断标准：旧 clean 文本 != 旧 ASR 原文 → 说明是用户改过的，保留。
    返回保留下来的条数。
    """
    if not clean_file.exists():
        return 0
    lines = clean_file.read_text(encoding="utf-8").splitlines()
    out, kept = [], 0
    for line in lines:
        parts = line.split("|")
        if len(parts) != 4:
            out.append(line)
            continue
        wav, spk, lang, text = parts
        manual = old_clean.get(wav)
        if manual and old_raw.get(wav) is not None and manual != old_raw.get(wav):
            if manual != text:
                kept += 1
            out.append(f"{wav}|{spk}|{lang}|{manual}")
        else:
            out.append(line)
    if kept:
        clean_file.write_text("\n".join(out), encoding="utf-8")
    return kept