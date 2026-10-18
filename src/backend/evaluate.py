# -*- coding: utf-8 -*-
"""
评测打分：用声纹模型判断合成出来的声音"像不像"原音。

原理：
1. 把参考音频和合成音频都送进声纹模型（ERes2NetV2），各得到一个"声纹向量"
2. 两个向量算余弦相似度，0~1，越大越像
3. 多句测试取平均，得到这个模型的分数

为什么这么做：
- 人耳听"像不像"有主观偏差，也听不了几十遍
- 声纹模型是客观测量，同一段音频每次结果一致，能对比不同模型版本

注意：评测是在 GPU 上用很小的模型（100MB），不跟声音引擎抢显存。
"""
import sys
import threading
from pathlib import Path

import numpy as np
import torch

# 找 GPT-SoVITS 根目录：环境变量优先，其次自动探测（P1 修复：找不到时不再崩在 import 阶段）
import os as _os

SOVITS_ROOT = None
_env_root = _os.environ.get("ABV_SOVITS_ROOT", "").strip()
if _env_root:
    _p = Path(_env_root)
    if (_p / "GPT_SoVITS" / "api_v2.py").exists():
        SOVITS_ROOT = _p
if SOVITS_ROOT is None:
    for _d in Path(r"D:\Dev\ai").glob("02_GPT-SoVITS_*"):
        if (_d / "GPT-SoVITS" / "api_v2.py").exists():
            SOVITS_ROOT = _d / "GPT-SoVITS"
            break

if SOVITS_ROOT is not None:
    SV_CKPT = SOVITS_ROOT / "GPT_SoVITS" / "pretrained_models" / "sv" / "pretrained_eres2netv2w24s4ep4.ckpt"
    ERES_DIR = SOVITS_ROOT / "GPT_SoVITS" / "eres2net"
else:
    SV_CKPT = None
    ERES_DIR = None

# 分数分档（实测后可以再调）
LEVELS = [
    (0.78, "很像"),
    (0.65, "像"),
    (0.50, "一般"),
    (0.0, "不像"),
]

_lock = threading.Lock()
_state = {"model": None, "device": "cpu"}


def _load_model():
    """懒加载声纹模型（CPU，省显存）。"""
    if _state["model"] is not None:
        return
    with _lock:
        if _state["model"] is not None:
            return
        if SOVITS_ROOT is None or SV_CKPT is None:
            raise RuntimeError("找不到 GPT-SoVITS 安装目录，无法加载声纹模型（请设置环境变量 ABV_SOVITS_ROOT）")
        if str(ERES_DIR) not in sys.path:
            sys.path.insert(0, str(ERES_DIR))
        from ERes2NetV2 import ERes2NetV2  # noqa
        state = torch.load(str(SV_CKPT), map_location="cpu", weights_only=False)
        model = ERes2NetV2(baseWidth=24, scale=4, expansion=4)
        model.load_state_dict(state)
        model.eval()
        _state["model"] = model


def _load_wav_16k(path: str) -> torch.Tensor:
    """读音频 → 16kHz 单声道 float32 张量。"""
    import soundfile as sf
    import librosa
    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        data = librosa.resample(data, orig_sr=sr, target_sr=16000)
    return torch.from_numpy(np.ascontiguousarray(data, dtype=np.float32))


def _fbank(wav: torch.Tensor) -> torch.Tensor:
    """算 80 维 fbank（跟 GPT-SoVITS 里 sv.py 的算法一致）。wav 是 1D 张量。"""
    if str(ERES_DIR) not in sys.path:
        sys.path.insert(0, str(ERES_DIR))
    import kaldi as Kaldi  # noqa
    # kaldi.fbank 要 [channel, samples]，所以 unsqueeze(0)
    return Kaldi.fbank(wav.unsqueeze(0), num_mel_bins=80, sample_frequency=16000, dither=0).unsqueeze(0)


def embedding(path: str) -> np.ndarray:
    """算一段音频的声纹向量（已归一化）。"""
    _load_model()
    wav = _load_wav_16k(path)
    # 太短或太长的兜底：截到 30 秒内
    if wav.numel() < 16000 * 0.5:
        raise ValueError("音频太短（不足 0.5 秒）")
    feat = _fbank(wav)
    with torch.no_grad():
        emb = _state["model"].forward3(feat)
    v = emb.detach().cpu().numpy().reshape(-1)
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def similarity(path_a: str, path_b: str) -> float:
    """两段音频的声纹相似度 0~1。"""
    a, b = embedding(path_a), embedding(path_b)
    return float(np.clip(np.dot(a, b), -1.0, 1.0))


def level_of(score: float) -> str:
    for th, name in LEVELS:
        if score >= th:
            return name
    return "不像"


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.clip(float(np.dot(a, b)), -1.0, 1.0))


def is_available() -> bool:
    return SV_CKPT is not None and SV_CKPT.exists()
