# -*- coding: utf-8 -*-
"""
本地翻译（中文 → 日文 等多语言互译）。

用本机 Ollama 的 Qwen3 模型，完全离线，文字不出电脑。
关键点：Qwen3 默认会输出思考过程，用 `/no_think` 关掉，否则会污染译文。
"""
import os
import re
import requests

OLLAMA_URL = os.environ.get("ABV_OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("ABV_OLLAMA_MODEL", "qwen3-local:latest")

LANG_NAME = {
    "zh": "简体中文",
    "ja": "自然的口语日文",
    "en": "自然的口语英文",
}

# 长文本逐句翻译，避免模型输出被截断
MAX_CHARS_PER_CALL = 180


class TranslateError(Exception):
    """翻译失败，message 是给人看的话。"""


def is_translator_up(timeout: float = 1.5) -> bool:
    """本机 Ollama 活着吗。"""
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False


def _clean(text: str) -> str:
    """去掉思考块和多余引号。"""
    text = re.sub(r"<think[^>]*>.*?</think\s*>", "", text, flags=re.S | re.I)
    text = re.sub(r"<think[^>]*>.*$", "", text, flags=re.S | re.I)   # 思考被截断的情况
    text = re.sub(r"</?think>", "", text, flags=re.I)
    text = text.strip()
    # 去掉整体包裹的引号 / 日式引号
    for q in ('"', "'", "「", "」", "『", "』"):
        if text.startswith(q) and text.endswith(q) and len(text) > 2:
            text = text[1:-1].strip()
    return text


def _translate_chunk(text: str, src: str, dst: str) -> str:
    """翻译一小段。"""
    src_name = LANG_NAME.get(src, src)
    dst_name = LANG_NAME.get(dst, dst)
    prompt = (
        f"/no_think 你是一个翻译。把下面的{src_name}翻译成{dst_name}，"
        f"只输出译文本身，不要解释、不要加引号、不要保留原文。\n{text}"
    )
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 400},
    }
    try:
        r = requests.post(f"{OLLAMA_URL}/api/generate", json=payload, timeout=180)
    except requests.exceptions.ConnectionError:
        raise TranslateError("翻译服务没启动（需要本机 Ollama），请先启动 Ollama 再试")
    except requests.exceptions.Timeout:
        raise TranslateError("翻译超时了，段落可能太长")

    if r.status_code != 200:
        raise TranslateError(f"翻译失败（Ollama 返回 {r.status_code}）")

    out = _clean(r.json().get("response", ""))
    if not out:
        raise TranslateError("翻译没有返回内容（模型可能还在加载，再试一次）")
    return out


def _split_for_translate(text: str) -> list:
    """按句号/问号/感叹号/换行切分，控制单次翻译长度。"""
    parts = re.split(r"(?<=[。！？!?\n])", text)
    chunks, buf = [], ""
    for p in parts:
        if not p.strip():
            continue
        if len(buf) + len(p) > MAX_CHARS_PER_CALL and buf:
            chunks.append(buf)
            buf = p
        else:
            buf += p
    if buf.strip():
        chunks.append(buf)
    return chunks or [text]


def translate(text: str, src: str, dst: str) -> str:
    """
    把 text 从 src 语言翻译成 dst 语言。src == dst 时原样返回。
    长文本自动按句切块翻译再拼起来。
    """
    text = (text or "").strip()
    if not text:
        return ""
    if src == dst:
        return text

    chunks = _split_for_translate(text)
    if len(chunks) == 1:
        return _translate_chunk(chunks[0], src, dst)

    out = []
    for c in chunks:
        out.append(_translate_chunk(c, src, dst).strip())
    # 日文/英文之间用空格拼接，中文直接拼
    joiner = "" if dst == "zh" else " "
    return joiner.join(out)
