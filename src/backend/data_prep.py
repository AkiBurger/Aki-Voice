# -*- coding: utf-8 -*-
"""
训练素材处理：让界面上能"提交音频 → 识别 → 清洗 → 训练"。

三步走（每步都有进度）：
1. 扫描：看文件夹里有多少段音频、总时长多少
2. 导入：把音频统一转成 16k 单声道 wav（训练要的格式）
3. 识别与清洗：批量 ASR 出文本，再过滤掉乱码/太短的句子
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


def start_import(path_str: str, max_samples: int = 800) -> dict:
    """把文件夹里的音频导入成训练用的 wav（后台跑）。"""
    if _state["running"]:
        return {"ok": False, "message": "有任务在跑，等它结束"}
    src = _resolve(path_str)
    if not src.is_dir():
        return {"ok": False, "message": f"不是文件夹：{src}"}

    files = [f for f in src.rglob("*") if f.is_file() and f.suffix.lower() in AUDIO_EXT]
    files.sort()
    if not files:
        return {"ok": False, "message": "这个文件夹里没有找到音频文件（支持 ogg/wav/flac/mp3 等）"}
    files = files[: max(1, int(max_samples))]

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
        with _lock:
            _state["running"] = False
            _state["message"] = f"导入完成：成功 {ok}/{len(files)}"
            _state["finished_at"] = datetime.now().isoformat(timespec="seconds")
        _say(_state["message"])

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "message": _state["message"], "total": len(files)}


def start_prepare() -> dict:
    """识别 + 清洗（后台跑，比较久）。"""
    if _state["running"]:
        return {"ok": False, "message": "有任务在跑，等它结束"}
    if not WAV_DIR.exists() or not list(WAV_DIR.glob("*.wav")):
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

            with _lock:
                _state["running"] = False
                _state["message"] = "识别与清洗完成，可以开始训练了"
                _state["finished_at"] = datetime.now().isoformat(timespec="seconds")
            _say(_state["message"])
        except Exception as e:
            with _lock:
                _state["running"] = False
                _state["error"] = str(e)
                _state["message"] = f"失败：{e}"
                _state["finished_at"] = datetime.now().isoformat(timespec="seconds")
            _say(_state["message"])

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
        clean_count = len([l for l in clean.read_text(encoding="utf-8").splitlines() if l.strip()])
    return {
        "wav_count": len(wavs),
        "clean_count": clean_count,
        "has_list": clean.exists(),
    }
