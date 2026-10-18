# -*- coding: utf-8 -*-
"""
训练数据清洗：把识别结果里的病态样本剔掉。

已知问题（实测踩到的）：
- FunASR 会把一声拖长的「えーーー」识别成 512 个「え」，
  pyopenjtalk 处理这种文本会直接崩溃（STATUS_STACK_BUFFER_OVERRUN）。

清洗规则：
1. 同一字符连续重复 > 6 次 → 判为病态，剔除
2. 文本长度与音频时长严重不匹配（每秒 < 1 字 或 > 12 字）→ 剔除
3. 文本长度 < 2 或 > 120 → 剔除
4. 音频文件不存在 → 剔除

输出：setsuna_clean.list（干净版）+ 清洗报告。
"""
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

DATA = Path(r"D:\Dev\projects\voice-studio\data\setsuna")
SRC = DATA / "setsuna.list"
DST = DATA / "setsuna_clean.list"

MAX_RUN = 6          # 同一字符最大连续重复
MIN_LEN, MAX_LEN = 2, 120
MIN_CPS, MAX_CPS = 1.0, 12.0   # 每秒字数合理范围


def audio_duration(path: Path) -> float:
    """用 soundfile 读时长（秒）。失败返回 0。"""
    try:
        import soundfile as sf
        info = sf.info(str(path))
        return info.frames / info.samplerate
    except Exception:
        return 0.0


def degenerate(text: str) -> bool:
    """同一字符连续重复过多，或整句只有 1~2 种字符且很长。"""
    for m in re.finditer(r"(.)\1{%d,}" % MAX_RUN, text):
        return True
    # 长度 > 30 且不同字符 <= 2 种：也是病态（如 "え、え、え、え…"）
    if len(text) > 30 and len(set(text)) <= 2:
        return True
    return False


def main():
    lines = [l for l in SRC.read_text(encoding="utf-8").splitlines() if l.strip()]
    print(f"原始样本: {len(lines)} 条\n")

    kept, dropped = [], []
    reasons = {"格式异常": 0, "病态重复": 0, "长度不符": 0, "时长不匹配": 0, "音频丢失": 0}

    for line in lines:
        parts = line.split("|")
        if len(parts) != 4:
            reasons["格式异常"] += 1
            dropped.append((line[:60], "格式异常"))
            continue
        wav, spk, lang, text = parts
        text = text.strip()

        # 1. 病态重复
        if degenerate(text):
            reasons["病态重复"] += 1
            dropped.append((f"{Path(wav).name} | {text[:30]}…", "病态重复"))
            continue

        # 2. 长度
        if not (MIN_LEN <= len(text) <= MAX_LEN):
            reasons["长度不符"] += 1
            dropped.append((f"{Path(wav).name} | len={len(text)}", "长度不符"))
            continue

        # 3. 音频存在 + 时长匹配
        wp = Path(wav)
        if not wp.exists():
            reasons["音频丢失"] += 1
            dropped.append((wp.name, "音频丢失"))
            continue
        dur = audio_duration(wp)
        if dur <= 0:
            reasons["时长不匹配"] += 1
            dropped.append((wp.name, "时长读不出"))
            continue
        cps = len(text) / dur
        if not (MIN_CPS <= cps <= MAX_CPS):
            reasons["时长不匹配"] += 1
            dropped.append((f"{wp.name} | {len(text)}字/{dur:.1f}秒={cps:.1f}字/秒", "时长不匹配"))
            continue

        kept.append(line)

    DST.write_text("\n".join(kept), encoding="utf-8")

    print(f"保留: {len(kept)} 条")
    print(f"剔除: {len(dropped)} 条")
    for k, v in reasons.items():
        if v:
            print(f"  {k}: {v}")
    print(f"\n清洗后数据: {DST}")
    if dropped:
        print("\n被剔除的样本（最多列 15 条）:")
        for name, why in dropped[:15]:
            print(f"  [{why}] {name}")


if __name__ == "__main__":
    main()
