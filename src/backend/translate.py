# -*- coding: utf-8 -*-
"""
翻译调度：优先用本地 Ollama（质量更好），连不上就用内置 opus-mt 模型。
"""
import os
import re
import requests

import translate_local

OLLAMA_URL = os.environ.get("ABV_OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("ABV_OLLAMA_MODEL", "qwen3-local:latest")

# 翻译引擎策略：auto = 有 Qwen 就用 Qwen，否则内置；builtin = 只用内置
ENGINE_MODE = os.environ.get("ABV_TRANSLATE_ENGINE", "auto")

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
    """翻译能力是否可用：Qwen 活着，或者内置模型已下载。"""
    if translate_local.is_available():
        return True
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


def _looks_broken(out: str, dst: str) -> bool:
    """
    译文质量粗检：中日文译文里混进成串英文字母，说明模型跑偏了。
    （实测 Qwen 偶尔会在日文里插 "already" 这类英文，念出来会很怪）
    """
    if not out or not out.strip():
        return True
    if dst in ("ja", "zh"):
        if re.search(r"[A-Za-z]{2,}", out):
            return True
    return False


def translate_with_engine(text: str, src: str, dst: str):
    """
    把 text 从 src 语言翻译成 dst 语言，返回 (译文, 用的哪个引擎)。
    策略：
      1. 内置模型支持这个方向，且（Qwen 不可用 或 强制内置）→ 用内置（快、零依赖）
      2. 否则用 Qwen（质量最好）
      3. Qwen 失败且内置支持 → 退回内置
    """
    text = (text or "").strip()
    if not text:
        return "", "none"
    if src == dst:
        return text, "none"

    qwen_up = is_translator_up()
    builtin_ok = translate_local.is_available() and translate_local.supported(src, dst)

    # 内置模型优先的情况：强制 builtin，或 Qwen 不可用
    if builtin_ok and (ENGINE_MODE == "builtin" or not qwen_up):
        try:
            return translate_local.translate(text, src, dst), "builtin"
        except Exception as e:
            if not qwen_up:
                raise TranslateError(f"内置翻译失败：{type(e).__name__}")
            # Qwen 可用就继续往下走

    # Qwen 优先（但结果要过质量检查；不合格就退回内置专用模型）
    if qwen_up and ENGINE_MODE != "builtin":
        try:
            chunks = _split_for_translate(text)
            joiner = "" if dst == "zh" else " "
            qwen_out = joiner.join([_translate_chunk(c, src, dst).strip() for c in chunks])
            if not _looks_broken(qwen_out, dst):
                return qwen_out, "qwen"
            # Qwen 跑偏（混入英文等）：用内置模型重翻
            if builtin_ok:
                return translate_local.translate(text, src, dst), "builtin-retry"
            return qwen_out, "qwen"
        except TranslateError:
            if builtin_ok:
                return translate_local.translate(text, src, dst), "builtin"
            raise

    # 兜底：内置
    if builtin_ok:
        return translate_local.translate(text, src, dst), "builtin"

    raise TranslateError("没有可用的翻译引擎：内置模型未下载，且 Ollama 没启动")


def translate(text: str, src: str, dst: str) -> str:
    """兼容旧调用：只返回译文。"""
    out, _engine = translate_with_engine(text, src, dst)
    return out
