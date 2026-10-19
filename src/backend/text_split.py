# -*- coding: utf-8 -*-
"""
文本分句 / 分块（给 TTS 用）。

目标不是切得最碎，而是切出适合朗读的句子块：
  · 一句 8~45 字（太短没上下文，太长模型容易崩）
  · 不切在引号中间
  · 不切出孤立的标点
  · 太短的相邻句合并，太长的在逗号处再切

1. 主用 pysbd（纯 Python 规则库，支持中/日/英，能处理引号和省略号）
2. pysbd 不可用时退回正则（并做同样的后处理）
3. 后处理：合并过短段、切分过长段、清理孤立标点
"""
import re

try:
    import pysbd
    _HAS_PYSBD = True
except Exception:  # pragma: no cover
    _HAS_PYSBD = False

# 每块的目标上限（字）
DEFAULT_MAX_CHARS = 45
# 低于这个长度的段会被尝试合并
MIN_CHARS = 8

# 语言映射 → pysbd 语言代码
_PYSBD_LANG = {"zh": "zh", "ja": "ja", "en": "en"}

# 句末标点（正则兜底用）
_END_PUNCT = r"[。！？!?；;]"
# 引号对
_QUOTES = [("「", "」"), ("『", "』"), ("（", "）"), ("(", ")"), ("“", "”"), ('"', '"')]
# 孤立标点（整段只有标点/省略号）
_ONLY_PUNCT = re.compile(r"^[。、，．.…！？!?～〜ー\-—\s]+$")


def _segment_by_pysbd(text: str, lang: str) -> list:
    """用 pysbd 切句。"""
    code = _PYSBD_LANG.get(lang, "zh")
    try:
        seg = pysbd.Segmenter(language=code, clean=False)
        parts = seg.segment(text)
        return [p.strip() for p in parts if p and p.strip()]
    except Exception:
        return []


def _segment_by_regex(text: str) -> list:
    """正则兜底：按句末标点切，标点留在句尾。"""
    parts, start = [], 0
    for m in re.finditer(_END_PUNCT, text):
        parts.append(text[start:m.end()])
        start = m.end()
    if text[start:].strip():
        parts.append(text[start:])
    return [p.strip() for p in parts if p.strip()]


def _unbalanced_quotes(s: str) -> bool:
    """检查句子里的引号是否配平（不配平说明切在引号中间了）。"""
    for left, right in _QUOTES:
        if left == right:
            if s.count(left) % 2 != 0:
                return True
        elif s.count(left) != s.count(right):
            return True
    return False


def _fix_quote_splits(parts: list) -> list:
    """把切在引号中间的相邻段合并回去。"""
    out = []
    for p in parts:
        if out and _unbalanced_quotes(out[-1]):
            out[-1] = out[-1] + p
        else:
            out.append(p)
    # 最后一段仍不配平：并回前一段
    while len(out) > 1 and _unbalanced_quotes(out[-1]):
        out[-2] = out[-2] + out.pop()
    return out


def _split_long(s: str, max_chars: int) -> list:
    """超长句在逗号/顿号处再切一刀。"""
    if len(s) <= max_chars:
        return [s]
    marks = [m.start() for m in re.finditer(r"[、，,；;：:]", s)]
    if not marks:
        return [s[i:i + max_chars] for i in range(0, len(s), max_chars)]
    pieces, start = [], 0
    for pos in marks:
        if pos + 1 - start >= max_chars * 0.6:      # 够长就切（尽量均分）
            pieces.append(s[start:pos + 1])
            start = pos + 1
    if start < len(s):
        pieces.append(s[start:])
    out = []
    for p in pieces:
        if len(p) > max_chars:
            out.extend([p[i:i + max_chars] for i in range(0, len(p), max_chars)])
        else:
            out.append(p)
    return [p for p in out if p.strip()]


def _merge_short(parts: list, min_chars: int = MIN_CHARS) -> list:
    """过短的段并到相邻段（优先并到前一句）。"""
    out = []
    for p in parts:
        if out and len(p) < min_chars:
            out[-1] = out[-1] + p
        elif out and len(out[-1]) < min_chars:
            out[-1] = out[-1] + p
        else:
            out.append(p)
    return out


def _drop_orphan_punct(parts: list) -> list:
    """丢掉只有一个标点的段，并到前一段。"""
    out = []
    for p in parts:
        if _ONLY_PUNCT.match(p):
            if out:
                out[-1] = out[-1] + p
            continue
        out.append(p)
    return out


def split_sentences(text: str, lang: str = "ja", max_chars: int = DEFAULT_MAX_CHARS) -> list:
    """
    把文本切成适合 TTS 的句子块。

    参数:
        text: 原文（应该是最终要朗读的语言）
        lang: "zh" | "ja" | "en"
        max_chars: 每块上限字数

    返回:
        list[str]
    """
    text = (text or "").strip()
    if not text:
        return []

    # 1. 切句
    parts = _segment_by_pysbd(text, lang) if _HAS_PYSBD else []
    if not parts:
        parts = _segment_by_regex(text)

    # 2. 修正引号被切断
    parts = _fix_quote_splits(parts)
    # 3. 丢掉孤立标点
    parts = _drop_orphan_punct(parts)
    # 4. 过短合并
    parts = _merge_short(parts)
    # 5. 过长再切
    out = []
    for p in parts:
        out.extend(_split_long(p, max_chars))
    # 6. 再合并一次
    out = _merge_short(out)

    return [p for p in out if p.strip()]


def estimate_seconds(text: str, chars_per_sec: float = 4.5) -> float:
    """粗估朗读秒数。中文/日文约 4.5 字每秒，英文按词算。"""
    if not text:
        return 0.0
    if re.match(r"^[\x20-\x7E]+$", text) and " " in text:
        words = len(text.split())
        return round(words / 2.2, 1)
    return round(len(text) / chars_per_sec, 1)


def split_method_name() -> str:
    """当前用的哪个分句引擎（给界面显示用）。"""
    return "pysbd" if _HAS_PYSBD else "regex"
