# -*- coding: utf-8 -*-
"""批量日语音频识别（Fun-ASR-Nano）。

扫描本目录 wav/ 下的音频，识别成日语文本，生成训练用清单：
    音频路径|说话人|ja|文本

模型路径用环境变量 ABV_FUNASR_SNAPSHOT 指定（指向 Fun-ASR-Nano 的快照目录）。
"""
import os
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

DATA = Path(__file__).resolve().parent
WAV_DIR = DATA / "wav"
OUT_LIST = DATA / f"{DATA.name}.list"
SPEAKER = os.environ.get("ABV_SPEAKER_NAME", "voice")
MODEL_DIR = os.environ.get("ABV_FUNASR_SNAPSHOT", "").strip()


def main():
    if not MODEL_DIR or not Path(MODEL_DIR).exists():
        sys.exit("请先设置 ABV_FUNASR_SNAPSHOT 环境变量，指向 Fun-ASR-Nano 快照目录")
    if not WAV_DIR.exists():
        sys.exit(f"找不到音频目录: {WAV_DIR}")

    from funasr import AutoModel
    print("加载识别模型（GPU）...", flush=True)
    model = AutoModel(model=MODEL_DIR, trust_remote_code=True,
                      device="cuda:0", disable_update=True)
    print("模型就绪\n", flush=True)

    wavs = sorted(WAV_DIR.glob("*.wav"))
    total = len(wavs)
    print(f"待识别: {total} 段\n", flush=True)

    results = []
    failed = 0
    t_start = time.time()
    for i, wav in enumerate(wavs, 1):
        try:
            res = model.generate(input=[str(wav)], cache={}, batch_size=1,
                                 language="日语", itn=True)
            text = (res[0].get("text") or "").strip() if res else ""
            if not text:
                failed += 1
                continue
            results.append(f"{wav}|{SPEAKER}|ja|{text}")
        except Exception as e:
            failed += 1
            print(f"  失败 {wav.name}: {str(e)[:80]}", flush=True)

        if i % 25 == 0 or i == total:
            el = time.time() - t_start
            eta = el / i * (total - i) if i else 0
            print(f"  进度 {i}/{total} · 失败 {failed} · 用时 {el/60:.1f} 分 · 预计剩余 {eta/60:.1f} 分", flush=True)

    OUT_LIST.write_text("\n".join(results), encoding="utf-8")
    print(f"\n完成。成功 {len(results)} / {total}，失败 {failed}")
    print(f"清单文件: {OUT_LIST}")


if __name__ == "__main__":
    main()
