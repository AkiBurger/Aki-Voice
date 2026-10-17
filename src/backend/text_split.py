# -*- coding: utf-8 -*-
"""
长文本切句工具。

目标：把一段长文案切成适合合成的小句。
- 每句尽量不超过 max_chars 字（默认 50）
- 中文按标点切，日文优先按「。」，英文按句号/问号/感叹号
- 切完保留标点（停顿感靠它）

约定：
- 整句数少于 min_sentences 时，把句子合并回长文本交给引擎
  （GPT-SoVITS 自己也有 text_split_method，短文本整段传效果更自然）
"""
import re

# 中文句子结束标点（含全角半角）
_CN_END = r"[。！？!?；;]"
# 日文句子结束标点
_JA_END = r"[。！？!?…]"
# 英文句子结束标点（排除小数点 3.14、缩写 e.g.）
_EN_END = r"(?<!\d)[.!?](?!\d)"

# 默认切分上限（字符数）
DEFAULT_MAX_CHARS = 50
# 少于这个句子数就不切了，整段交给引擎
MIN_SENTENCES = 2


def split_sentences(text: str, lang: str, max_chars: int = DEFAULT_MAX_CHARS):
    """
    把长文本切成小句列表。

    参数:
        text: 原文
        lang: "zh" | "ja" | "en" | "auto"
        max_chars: 单句上限，超过会在逗号处继续切

    返回:
        list[str]，每句都是非空字符串
    """
    text = (text or "").strip()
    if not text:
        return []

    if lang == "ja":
        sentences = _split_by_punct(text, _JA_END)
    elif lang == "en":
        sentences = _split_by_punct(text, _EN_END)
    else:
        # 中文与 auto 走同一套标点
        sentences = _split_by_punct(text, _CN_END)

    # 句数太少，交给引擎自己处理
    if len(sentences) < MIN_SENTENCES:
        return [text]

    # 单句超长，按逗号/顿号再切一刀
    result = []
    for s in sentences:
        if len(s) > max_chars:
            result.extend(_split_by_punct(s, r"[，,、\s]+", keep=True))
        else:
            result.append(s)
    return [s for s in result if s.strip()]


def _split_by_punct(text: str, pattern: str, keep: bool = True):
    """
    按标点切句。

    keep=True 时把标点留在句尾（"你好。再见。" -> ["你好。","再见。"]）
    keep=False 时标点单独成段，用于合并
    """
    if not keep:
        parts = re.split(f"({pattern})", text)
        sentences = []
        for i in range(0, len(parts), 2):
            chunk = parts[i]
            if i + 1 < len(parts):
                chunk += parts[i + 1]
            if chunk.strip():
                sentences.append(chunk)
        return sentences

    # 用正向后顾做“切而不丢”：
    # 找到所有结束标点位置，在标点之后切开
    matches = list(re.finditer(pattern, text))
    if not matches:
        return [text]
    sentences = []
    start = 0
    for m in matches:
        end = m.end()
        sentences.append(text[start:end])
        start = end
    tail = text[start:]
    if tail.strip():
        sentences.append(tail)
    return [s for s in sentences if s.strip()]


def estimate_seconds(text: str, chars_per_sec: float = 4.5) -> float:
    """粗估朗读秒数。中文/日文约 4.5 字每秒，英文按词算。"""
    if not text:
        return 0.0
    # 英文按词
    if re.match(r"^[\x20-\x7E]+$", text) and " " in text:
        words = len(text.split())
        return round(words / 2.2, 1)  # 约 2.2 词/秒
    return round(len(text) / chars_per_sec, 1)
