# -*- coding: utf-8 -*-
"""
GPT-SoVITS 引擎客户端。

只做一件事：把一段文本 + 参考音频发给 9880 端口的引擎，拿回 wav 字节。

引擎参数（对照 api_v2.py 实测确认）：
- POST http://127.0.0.1:9880/tts
- text_lang: "zh" | "ja" | "en" | "auto"（v2 语言集合，见 TTS.py v2_languages）
- ref_audio_path: 参考音频的绝对路径（引擎在自己的进程里读文件，必须绝对路径）
- prompt_text: 参考音频对应的文本。可留空 —— v2 模型支持无参考文本模式
  （只有 SoVITS_V3 才强制要求 prompt_text 非空，v2 不要求）
- streaming_mode: 0（关闭流式，一次拿回完整 wav，方便拼接）
- 成功返回 audio/wav 字节流；失败返回 400 + JSON {"message": ..., "Exception": ...}
"""
import os
import json
from typing import Optional

import requests

ENGINE_URL = os.environ.get("ABV_ENGINE_URL", "http://127.0.0.1:9880")


class EngineError(Exception):
    """引擎出问题时抛这个，message 是人话，直接能给用户看。"""


def is_engine_up(timeout: float = 2.0) -> bool:
    """引擎进程活着吗（/docs 是 FastAPI 自带页面，通了就算活着）。"""
    try:
        r = requests.get(f"{ENGINE_URL}/docs", timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False


def synthesize(text: str, text_lang: str, ref_audio_path: str,
               prompt_lang: Optional[str] = None, prompt_text: str = "",
               speed_factor: float = 1.0,
               seed: int = -1, temperature: float = 0.8, top_k: int = 10,
               repetition_penalty: float = 1.2,
               aux_ref_audio_paths: Optional[list] = None) -> bytes:
    """
    调引擎合成一段语音，返回 wav 字节。

    参数:
        text: 要念的话
        text_lang: "zh" | "ja" | "en" | "auto"
        ref_audio_path: 参考音频绝对路径
        prompt_lang: 参考音频的语言（留空就用 text_lang）
        prompt_text: 参考音频的文本（可留空）
        speed_factor: 语速，1.0 正常
        seed: -1 随机；固定数字则结果可复现
        temperature: 采样温度，越低越稳（默认 0.8，比 1.0 稳很多）
        top_k: 采样范围，越小越稳（默认 10）
        repetition_penalty: 重复惩罚，防念重复/卡壳（默认 1.2）
        aux_ref_audio_paths: 额外的参考音频，用来融合音色（多段平均更稳）

    返回:
        wav 文件字节
    """
    payload = {
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": ref_audio_path,
        "prompt_lang": prompt_lang or text_lang,
        "prompt_text": prompt_text,
        "top_k": int(top_k),
        "top_p": 1,
        "temperature": float(temperature),
        "text_split_method": "cut5",
        "batch_size": 1,
        "speed_factor": speed_factor,
        "fragment_interval": 0.3,
        "seed": int(seed),
        "repetition_penalty": float(repetition_penalty),
        "media_type": "wav",
        "streaming_mode": 0,
        "parallel_infer": True,
    }
    if aux_ref_audio_paths:
        payload["aux_ref_audio_paths"] = list(aux_ref_audio_paths)

    try:
        r = requests.post(f"{ENGINE_URL}/tts", json=payload, timeout=600)
    except requests.exceptions.ConnectionError:
        raise EngineError("声音引擎还没就绪，请稍等它加载完再试")
    except requests.exceptions.Timeout:
        raise EngineError("合成超时了。这段可能太长，试着切成短句再试")

    if r.status_code == 200:
        return r.content

    # 引擎返回的错误一般是 JSON
    try:
        detail = r.json()
        msg = detail.get("message") or detail.get("Exception") or "未知错误"
    except Exception:
        msg = r.text[:200] or "未知错误"

    # 把引擎的英文错误翻成人话（常见几种）
    if "out of memory" in str(msg).lower():
        raise EngineError("显存不够了。把别的大程序关掉，或者重启引擎再试")
    if "not exists" in str(msg):
        raise EngineError(f"参考音频文件不存在：{ref_audio_path}")
    raise EngineError(f"合成失败：{msg}")
