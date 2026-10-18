# -*- coding: utf-8 -*-
"""
雪菜训练数据 · 批量日语识别（Fun-ASR-Nano）。

把 data/setsuna/wav/ 下全部 wav 识别成日语文本，
输出 GPT-SoVITS 训练用的 .list 文件：
    音频路径|雪菜|ja|文本

CPU 控制：GPU 推理（cuda:0），batch_size=1 顺序跑，不给 CPU 加压力。
每 25 条打印一次进度，全部完成后写 list 并统计失败数。
"""
import json
import os
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

WAV_DIR = Path(r"D:\Dev\projects\voice-studio\data\setsuna\wav")
OUT_LIST = Path(r"D:\Dev\projects\voice-studio\data\setsuna\setsuna.list")
MODEL_DIR = r"D:\Dev\cache\huggingface\hub\models--FunAudioLLM--Fun-ASR-Nano-2512\snapshots\272c57b82523ada6fd87095e955f8e29100979ab"

def main():
    from funasr import AutoModel
    print("加载识别模型（GPU）...", flush=True)
    model = AutoModel(
        model=MODEL_DIR, trust_remote_code=True,
        device="cuda:0", disable_update=True,
    )
    print("模型就绪\n", flush=True)

    wavs = sorted(WAV_DIR.glob("*.wav"))
    total = len(wavs)
    print(f"待识别: {total} 段\n", flush=True)

    results = []
    failed = 0
    t_start = time.time()
    for i, wav in enumerate(wavs, 1):
        try:
            res = model.generate(
                input=[str(wav)], cache={}, batch_size=1,
                language="日语", itn=True,
            )
            text = (res[0].get("text") or "").strip() if res else ""
            if not text:
                failed += 1
                continue
            # GPT-SoVITS .list 格式：路径|说话人|语言|文本
            results.append(f"{wav}|雪菜|ja|{text}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {wav.name}: {str(e)[:80]}", flush=True)

        if i % 25 == 0 or i == total:
            el = time.time() - t_start
            eta = el / i * (total - i) if i else 0
            print(f"  进度 {i}/{total} · 失败 {failed} · 用时 {el/60:.1f} 分 · 预计剩余 {eta/60:.1f} 分", flush=True)

    OUT_LIST.write_text("\n".join(results), encoding="utf-8")
    print(f"\n完成。成功 {len(results)} / {total}，失败 {failed}")
    print(f"list 文件: {OUT_LIST}")

if __name__ == "__main__":
    main()
