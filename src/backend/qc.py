# -*- coding: utf-8 -*-
"""
质检：检查音频和标注文本有没有问题。

音频侧（自动测）：
- 太短（<1 秒）/ 太长（>20 秒）
- 几乎全是静音（有效声音少）
- 音量太小 / 爆音（削波）
- 文件读不出来

文本侧（看标注）：
- 乱码/重复（同一字符连续重复，ASR 常见毛病）
- 太短（<4 字）/ 太长（>60 字）
- 同一句文本重复出现（说明数据重复）

输出：data/qc_report.json，界面上按"通过/警告/不合格"分类显示。
"""
import json
import re
from datetime import datetime
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data" / "setsuna"
WAV_DIR = DATA_DIR / "wav"
LIST_FILE = DATA_DIR / "setsuna_clean.list"
REPORT_FILE = PROJECT_ROOT / "data" / "qc_report.json"

# 判定阈值
MIN_SEC = 1.0
MAX_SEC = 20.0
MIN_RMS_DB = -40.0     # 小于这个算太小声
WARN_RMS_DB = -34.0
MAX_SILENCE = 0.60     # 静音占比超过这个算无效
WARN_SILENCE = 0.40
MAX_CLIP = 0.01        # 削波采样占比


def _analyze_audio(path: Path) -> dict:
    """分析一段音频的基本质量指标。"""
    import soundfile as sf
    try:
        data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    except Exception as e:
        return {"error": f"读不出来：{e}"}
    if data.ndim > 1:
        data = data.mean(axis=1)
    dur = len(data) / sr if sr else 0

    if len(data) == 0:
        return {"error": "空文件"}

    peak = float(np.max(np.abs(data)))
    rms = float(np.sqrt(np.mean(data ** 2)))
    rms_db = 20 * np.log10(rms) if rms > 1e-8 else -120.0

    # 逐 20ms 帧判断静音
    win = max(1, int(sr * 0.02))
    n = len(data) // win
    silent_ratio = 0.0
    if n > 0:
        frames = data[: n * win].reshape(n, win)
        frame_rms = np.sqrt(np.mean(frames ** 2, axis=1))
        silent_ratio = float(np.mean(frame_rms < 0.003))

    clip_ratio = float(np.mean(np.abs(data) > 0.99))

    return {
        "duration": round(dur, 2),
        "peak_db": round(20 * np.log10(peak) if peak > 1e-8 else -120, 1),
        "rms_db": round(float(rms_db), 1),
        "silence": round(silent_ratio, 3),
        "clip": round(clip_ratio, 4),
        "sample_rate": sr,
    }


def _judge_audio(m: dict) -> tuple:
    """返回 (等级, 原因列表)。等级：pass / warn / fail"""
    if m.get("error"):
        return "fail", [m["error"]]
    reasons, level = [], "pass"
    d = m["duration"]
    if d < MIN_SEC:
        reasons.append(f"太短（{d} 秒）")
        level = "fail"
    elif d < 2:
        reasons.append(f"偏短（{d} 秒）")
        level = "warn" if level == "pass" else level
    if d > MAX_SEC:
        reasons.append(f"太长（{d} 秒）")
        level = "fail"
    elif d > 12:
        reasons.append(f"偏长（{d} 秒）")
        level = "warn" if level == "pass" else level
    if m["rms_db"] < MIN_RMS_DB:
        reasons.append(f"声音太小（{m['rms_db']} dB）")
        level = "fail"
    elif m["rms_db"] < WARN_RMS_DB:
        reasons.append(f"音量偏小（{m['rms_db']} dB）")
        level = "warn" if level == "pass" else level
    if m["silence"] > MAX_SILENCE:
        reasons.append(f"静音太多（{int(m['silence']*100)}%）")
        level = "fail"
    elif m["silence"] > WARN_SILENCE:
        reasons.append(f"静音偏多（{int(m['silence']*100)}%）")
        level = "warn" if level == "pass" else level
    if m["clip"] > MAX_CLIP:
        reasons.append(f"有爆音（削波 {m['clip']*100:.1f}%）")
        level = "warn" if level == "pass" else level
    return level, reasons


def _load_texts() -> dict:
    """读标注：{wav 文件名: 文本}"""
    out = {}
    if not LIST_FILE.exists():
        return out
    for line in LIST_FILE.read_text(encoding="utf-8").splitlines():
        parts = line.split("|")
        if len(parts) == 4:
            out[Path(parts[0]).name] = parts[3]
    return out


def _judge_text(text: str) -> tuple:
    """文本质量判定。"""
    if not text or not text.strip():
        return "fail", ["没有文本"]
    reasons, level = [], "pass"
    if len(text) < 4:
        reasons.append("文本太短")
        level = "warn"
    if len(text) > 60:
        reasons.append("文本太长")
        level = "warn"
    # 同一个字连续重复 3 次以上（ASR 幻觉典型特征）
    if re.search(r"(.)\1{2,}", text):
        reasons.append("有重复字符")
        level = "fail"
    # 中文字符占比过低
    if len(text) > 6:
        cn = len(re.findall(r"[\u3040-\u30ff\u4e00-\u9fff]", text))
        if cn / len(text) < 0.5:
            reasons.append("不像日文文本")
            level = "fail"
    return level, reasons


def run_qc() -> dict:
    """跑一次完整质检，返回报告并存盘。"""
    wavs = sorted(WAV_DIR.glob("*.wav")) if WAV_DIR.exists() else []
    texts = _load_texts()

    items = []
    summary = {"pass": 0, "warn": 0, "fail": 0, "total": len(wavs)}
    text_counts = {}
    for w in wavs:
        m = _analyze_audio(w)
        lv_a, rs_a = _judge_audio(m)

        text = texts.get(w.name, "")
        lv_t, rs_t = _judge_text(text) if text else ("warn", ["还没有标注文本"])
        text_counts[text] = text_counts.get(text, 0) + 1

        reasons = rs_a + rs_t
        level = lv_a
        if lv_t == "fail" or (lv_t == "warn" and level == "pass"):
            level = lv_t

        summary[level] = summary.get(level, 0) + 1
        items.append({
            "name": w.name,
            "duration": m.get("duration"),
            "rms_db": m.get("rms_db"),
            "silence": m.get("silence"),
            "clip": m.get("clip"),
            "text": text,
            "level": level,
            "reasons": reasons,
        })

    # 文本重复检测（同一句出现多次）
    dup_texts = {t: c for t, c in text_counts.items() if t and c > 1 and len(t) > 3}
    for it in items:
        if it["text"] in dup_texts:
            it["level"] = "warn" if it["level"] == "pass" else it["level"]
            it["reasons"].append("同一句文本重复出现")

    report = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "summary": summary,
        "items": items,
        "duplicate_texts": len(dup_texts),
    }
    REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def load_report() -> dict:
    try:
        if REPORT_FILE.exists():
            return json.loads(REPORT_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}
