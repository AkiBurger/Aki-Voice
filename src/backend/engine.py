# -*- coding: utf-8 -*-
"""
GPT-SoVITS 引擎客户端。

把文本 + 参考音频发给 9880 端口的 /tts，拿回 wav 字节。
参数细节见 api_v2.py；失败时引擎返回 400 + JSON。
"""
import os
import time
import json
from typing import Optional

import requests

ENGINE_URL = os.environ.get("ABV_ENGINE_URL", "http://127.0.0.1:9880")


class EngineError(Exception):
    """引擎出问题时抛这个，message 是人话，直接能给用户看。"""


# 当前已挂载的权重（用于避免每次合成都重新加载）
_attached = {"sovits": None, "gpt": None}


def set_models(sovits_file: str = "", gpt_file: str = "") -> None:
    """
    切换引擎当前使用的权重（界面选模型要真的生效）。
    文件名相对 GPT-SoVITS 根目录，如 "SoVITS_weights_v2Pro/xxx.pth"。
    已挂载过的会跳过，避免重复加载。
    """
    if sovits_file and _attached["sovits"] != sovits_file:
        try:
            r = requests.get(f"{ENGINE_URL}/set_sovits_weights",
                             params={"weights_path": sovits_file}, timeout=180)
            if r.status_code != 200:
                raise EngineError(f"切换音色权重失败：HTTP {r.status_code}")
            _attached["sovits"] = sovits_file
        except requests.exceptions.RequestException as e:
            raise EngineError(f"切换音色权重失败：{e}")
    if gpt_file and _attached["gpt"] != gpt_file:
        try:
            r = requests.get(f"{ENGINE_URL}/set_gpt_weights",
                             params={"weights_path": gpt_file}, timeout=180)
            if r.status_code != 200:
                raise EngineError(f"切换韵律权重失败：HTTP {r.status_code}")
            _attached["gpt"] = gpt_file
        except requests.exceptions.RequestException as e:
            raise EngineError(f"切换韵律权重失败：{e}")


_last_ok_ts = 0.0          # 最近一次探测成功的时间
_UP_GRACE_SEC = 60.0       # 合成期间引擎忙、/docs 可能超时，这段时间内先当它还活着


def is_engine_up(timeout: float = 5.0) -> bool:
    """引擎进程活着吗（/docs 通了就算活着）。
    引擎重启后会回到默认权重，所以真的掉线时清空挂载缓存，下次合成重新挂。"""
    global _last_ok_ts
    try:
        r = requests.get(f"{ENGINE_URL}/docs", timeout=timeout)
        up = r.status_code == 200
    except Exception:
        up = False
    if up:
        _last_ok_ts = time.time()
        return True
    # 探测失败可能只是引擎在合成（同步推理阻塞了 HTTP），刚成功过就再等等
    if time.time() - _last_ok_ts < _UP_GRACE_SEC:
        return True
    _attached["sovits"] = None
    _attached["gpt"] = None
    return False


def synthesize(text: str, text_lang: str, ref_audio_path: str,
               prompt_lang: Optional[str] = None, prompt_text: str = "",
               speed_factor: float = 1.0,
               seed: int = -1, temperature: float = 0.8, top_k: int = 10,
               repetition_penalty: float = 1.2,
               aux_ref_audio_paths: Optional[list] = None,
               text_split_method: str = "cut3",
               fragment_interval: float = 0.15) -> bytes:
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
        "text_split_method": text_split_method,
        "batch_size": 1,
        "speed_factor": speed_factor,
        "fragment_interval": fragment_interval,
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
        # 校验真的是 wav，别把空响应/HTML 错误页存成音频
        body = r.content or b""
        if len(body) < 44 or not (body[:4] == b"RIFF" and body[8:12] == b"WAVE"):
            ct = r.headers.get("Content-Type", "?")
            raise EngineError(f"引擎返回的不是音频（{len(body)} 字节, {ct}），请重启引擎再试")
        return body

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
