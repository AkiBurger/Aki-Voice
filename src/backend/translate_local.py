# -*- coding: utf-8 -*-
"""
内置翻译模型（不依赖任何外部服务）。

用的是 Helsinki-NLP opus-mt-zh-ja：中→日专用小模型，约 300MB。
- 跑在 CPU 上，不吃显存（显存要留给声音引擎）
- 短句约 0.1~0.2 秒，比本地大模型快 10 倍
- 首次使用时才加载，加载后常驻内存（约 1.2GB）
"""
import threading

import torch
from transformers import MarianMTModel, MarianTokenizer

MODEL_REPO = "models--shun89--opus-mt-zh-ja"
HF_CACHE = r"D:\Dev\cache\huggingface\hub"

# 已加载的模型（懒加载、线程安全）
_lock = threading.Lock()
_state = {"tokenizer": None, "model": None, "dir": None}
_load_error = None


def _find_model_dir():
    """在 HF 缓存里找模型快照目录。"""
    from pathlib import Path
    base = Path(HF_CACHE) / MODEL_REPO / "snapshots"
    if not base.exists():
        return None
    snaps = [p for p in base.iterdir() if p.is_dir()]
    if not snaps:
        return None
    # 取最新快照
    snaps.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return str(snaps[0])


def is_available() -> bool:
    """内置模型是否已经下载好。"""
    return _find_model_dir() is not None


def supported(src: str, dst: str) -> bool:
    """这个模型只做 中→日。"""
    return src == "zh" and dst == "ja"


def _ensure_loaded():
    """懒加载模型。第一次加载约 3~8 秒。"""
    global _load_error
    if _state["model"] is not None:
        return
    with _lock:
        if _state["model"] is not None:
            return
        d = _find_model_dir()
        if d is None:
            raise RuntimeError("内置翻译模型没下载")
        tok = MarianTokenizer.from_pretrained(d)
        # 权重是 fp32（官方 bin），CPU 上正常；显式指定避免 dtype 问题
        model = MarianMTModel.from_pretrained(d, dtype=torch.float32)
        model.eval()
        _state.update({"tokenizer": tok, "model": model, "dir": d})


def translate(text: str, src: str = "zh", dst: str = "ja") -> str:
    """
    用内置模型翻译。只支持 中→日；其他方向抛 ValueError 让上层决定。
    """
    text = (text or "").strip()
    if not text:
        return ""
    if not supported(src, dst):
        raise ValueError(f"内置模型不支持 {src}→{dst}")
    _ensure_loaded()

    tok = _state["tokenizer"]
    model = _state["model"]

    # 长文本按句切，避免爆长度
    pieces = _split(text, 200)
    outs = []
    for p in pieces:
        batch = tok([p], return_tensors="pt", padding=True, truncation=True, max_length=256)
        with torch.no_grad():
            gen = model.generate(**batch, max_new_tokens=160, num_beams=4)
        outs.append(tok.batch_decode(gen, skip_special_tokens=True)[0].strip())
    joiner = "" if dst == "zh" else " "
    return joiner.join([o for o in outs if o])


def _split(text: str, limit: int) -> list:
    import re
    parts = re.split(r"(?<=[。！？!?\n])", text)
    chunks, buf = [], ""
    for p in parts:
        if not p.strip():
            continue
        if len(buf) + len(p) > limit and buf:
            chunks.append(buf)
            buf = p
        else:
            buf += p
    if buf.strip():
        chunks.append(buf)
    return chunks or [text]
