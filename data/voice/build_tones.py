# -*- coding: utf-8 -*-
"""按语气生成参考音频库。

读清洗后的清单，用关键词规则给每条文本判语气，每种语气挑 2 条
3~7.5 秒的样本复制到 data/ref/tones/，并写 tones.json。

合成时 app.py 会按语气挑对应参考音频；没有这个库就退回默认参考音频。

用法:
    python data/voice/build_tones.py
"""
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src" / "backend"))

from emotion import TONES, judge_tone  # noqa: E402

DATA = Path(__file__).resolve().parent
WAV_DIR = DATA / "wav"
CLEAN_LIST = DATA / f"{DATA.name}_clean.list"
OUT_DIR = ROOT / "data" / "ref" / "tones"

MIN_DUR, MAX_DUR = 3.0, 7.5
PER_TONE = 2


def main() -> None:
    import soundfile as sf

    if not CLEAN_LIST.exists():
        sys.exit(f"找不到标注文件: {CLEAN_LIST}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.wav"):
        old.unlink()

    candidates = {tone: [] for tone in TONES}
    for line in CLEAN_LIST.read_text(encoding="utf-8").splitlines():
        parts = line.split("|")
        if len(parts) != 4:
            continue
        wav_path, _spk, _lang, text = parts
        wav = Path(wav_path)
        if not wav.exists():
            continue
        try:
            info = sf.info(str(wav))
            duration = info.frames / info.samplerate
        except Exception:
            continue
        if not (MIN_DUR <= duration <= MAX_DUR):
            continue
        tone = judge_tone(text, "ja")["tone"]
        candidates[tone].append((abs(duration - 4.5), wav, text, round(duration, 2)))

    mapping = {}
    for tone in TONES:
        candidates[tone].sort(key=lambda item: item[0])
        picked = []
        for _score, wav, text, duration in candidates[tone][:PER_TONE]:
            name = f"{tone}_{wav.stem}.wav"
            shutil.copy2(wav, OUT_DIR / name)
            picked.append({"file": name, "text": text, "duration": duration})
        if picked:
            mapping[tone] = picked

    (OUT_DIR / "tones.json").write_text(
        json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"生成完成: {OUT_DIR}")
    for tone in TONES:
        items = mapping.get(tone, [])
        print(f"  {tone}: {len(items)} 条" + (f"  例: {items[0]['text'][:24]}" if items else ""))


if __name__ == "__main__":
    main()
