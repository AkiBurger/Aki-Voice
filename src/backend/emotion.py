# -*- coding: utf-8 -*-
"""
情绪判断（v1：关键词规则版）。

设计原则（见 docs/01-功能全流程.md）：
- 合成前读一遍文本，猜该用什么语气
- 猜完摆在界面上，用户能改 —— 所以这里只负责"给个靠谱的初值"
- 以后要接本地大模型（Ollama + Qwen3），把 judge 函数换成调模型即可，
  对外接口保持一致

关键词是"强信号"优先：哭泣/怒骂这些词出现就基本确定情绪，
程度词（哈哈/嘿嘿）算弱信号。
"""
from typing import Optional

# 语气枚举（前端契约用中文，内部也用中文，保持简单）
TONES = ["平静", "开心", "悲伤", "生气", "惊讶", "害怕"]

# 强信号：出现基本就是该情绪
_STRONG = {
    "悲伤": ["泣い", "泣き", "呜咽", "哭泣", "大哭", "痛哭", "ごめん", "ごめんなさい",
             "さよなら", "永别", "别れ", "死ん", "去世", "走了", "没能", "来不及",
             "悲し", "寂し", "辛い", "つらい", "遅かっ", "もう遅い", "いなくな"],
    "生气": ["混蛋", "畜生", "くそ", "ばか", "バカ", "怒", "可恶", "找死", "闭嘴",
             "黙れ", "ふざけ", "岂有此理", "气死", "むかつ", "ムカつ", "許さ", "うるさ",
             "ややこしい", "ブチキ", "着信拒否"],
    "惊讶": ["什么", "不会吧", "居然", "怎么可能", "まさか", "えええ", "纳尼", "天哪",
             "难以置信", "难道", "えっ", "うそ", "嘘でしょ", "びっくり",
             "なんですって"],
    "害怕": ["怖い", "こわい", "害怕", "好怕", "救命", "たすけて", "恐怖", "不要过来",
             "别过来", "幽灵", "鬼", "不安", "やだ", "いやだ", "震え"],
    "开心": ["やった", "太棒", "太好了", "万岁", "好耶", "lucky", "ラッキー",
             "うれし", "嬉し", "楽しい", "楽しかった", "ありがとう", "えへへ", "あはは",
             "ふふ", "笑っ", "好きだよ"],
}

# 弱信号：要出现两次以上才认定（笑闹）
_WEAK = {
    "开心": ["哈哈", "嘿嘿", "嘻嘻", "呵呵", "笑", "楽しい", "嬉しい", "开心", "高兴",
             "好玩", "有趣", "面白"],
    "悲伤": ["难过", "伤心", "悲伤", "寂寞", "孤独", "哀", "痛", "つらい", "辛い"],
    "生气": ["讨厌", "烦", "恨", "不爽", "哼"],
}

# 强信号命中 1 次即生效，弱信号要出现两次


def judge_tone(text: str, lang: str = "auto") -> dict:
    """
    判断一段文本该用什么语气。

    返回:
        {"tone": str, "confidence": float}  tone 是 TONES 之一，默认"平静"
    """
    text = text or ""
    best_tone = "平静"
    best_score = 0.0

    # 强信号
    for tone, words in _STRONG.items():
        hits = sum(1 for w in words if w in text)
        if hits > 0:
            score = 0.8 + min(hits * 0.05, 0.15)
            if score > best_score:
                best_tone, best_score = tone, score

    if best_score > 0:
        return {"tone": best_tone, "confidence": round(best_score, 2)}

    # 弱信号：两处以上才认
    for tone, words in _WEAK.items():
        hits = sum(1 for w in words if w in text)
        if hits >= 2:
            score = 0.6 + min(hits * 0.05, 0.2)
            if score > best_score:
                best_tone, best_score = tone, score

    if best_score > 0:
        return {"tone": best_tone, "confidence": round(best_score, 2)}

    return {"tone": "平静", "confidence": 0.5}


# 以后接本地大模型的预留接口
class ToneJudger:
    """情绪判断器接口。v1 用关键词实现，以后可换 LLM 实现。"""

    def judge(self, text: str, lang: str = "auto") -> dict:
        return judge_tone(text, lang)
