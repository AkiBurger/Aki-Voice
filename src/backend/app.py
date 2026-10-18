# -*- coding: utf-8 -*-
"""
AkiBurger Voice 后端服务。

职责：
- 给前端提供 /api/* 接口
- 代理 GPT-SoVITS 引擎（9880）
- 长文本切句 -> 逐句合成 -> 拼接 -> 存盘
- 静态托管：前端页面 + 合成产物

启动：
    cd D:\Dev\projects\voice-studio
    D:\Dev\ai\02_GPT-SoVITS_配音\.venv\Scripts\python.exe src\backend\app.py

监听 127.0.0.1:8017
"""
import io
import json
import re
import shutil
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine import EngineError, is_engine_up, synthesize
from emotion import judge_tone, TONES
from text_split import estimate_seconds, split_sentences
from translate import TranslateError, is_translator_up, translate, translate_with_engine

import evaluate as evaluator   # 声纹打分（评测用）
import trainer                 # 训练任务管理（第三期）
import data_prep               # 训练素材：导入/识别/清洗（第三期）

# ---------- 路径 ----------
PROJECT_ROOT = Path(__file__).resolve().parents[2]   # voice-studio/
DATA_DIR = PROJECT_ROOT / "data"
REF_DIR = DATA_DIR / "ref"                            # 参考音频都在这
OUTPUT_DIR = PROJECT_ROOT / "outputs"                 # 合成产物都在这
STATIC_DIR = PROJECT_ROOT / "src" / "static"          # 前端静态页面
CONFIG_FILE = PROJECT_ROOT / "config.json"

# GPT-SoVITS 的权重目录（扫描用，不写死具体模型）
SOVITS_ROOT = None
for _d in Path(r"D:\Dev\ai").glob("02_GPT-SoVITS_*"):
    if (_d / "GPT-SoVITS" / "api_v2.py").exists():
        SOVITS_ROOT = _d / "GPT-SoVITS"
        break
SOVITS_WEIGHTS_DIR = (SOVITS_ROOT / "SoVITS_weights_v2Pro") if SOVITS_ROOT else None
GPT_WEIGHTS_DIR = (SOVITS_ROOT / "GPT_weights_v2Pro") if SOVITS_ROOT else None

HOST = "127.0.0.1"
PORT = 8017

app = FastAPI(title="AkiBurger Voice")


# ---------- 禁止前端被浏览器缓存 ----------
# 改代码后用户不按 Ctrl+F5 也能拿到最新界面（静态文件和页面一律不缓存）
@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/static/") and not path.startswith("/static/output/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        # 去掉会让浏览器用旧副本的校验头
        for h in ("etag", "last-modified"):
            if h in response.headers:
                del response.headers[h]
    return response


# ---------- 静态托管（audio_url 能直接播） ----------
# 注意顺序：/static/output 必须挂在 /static 前面，否则会被后者吞掉
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static/output", StaticFiles(directory=str(OUTPUT_DIR)), name="output")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------- 请求模型 ----------
class SynthesizeRequest(BaseModel):
    text: str
    lang: str = "ja"                    # 输出语言：ja | zh | en
    input_lang: str = ""                # 输入文本的语言；留空=与输出语言相同
    voice: str = ""                     # 模型 id（如 e2）；留空=默认
    tone: str = "自动"                  # 平静|开心|悲伤|生气|惊讶|害怕|自动
    speed: float = 1.0
    seed: int = -1                      # -1 随机；指定数字则结果可复现
    temperature: float = 0.8            # 越低越稳（默认 0.8，比 1.0 稳）
    top_k: int = 10                     # 采样范围，越小越稳
    repetition_penalty: float = 1.2     # 防念重复/卡壳
    use_aux_ref: bool = False           # 多参考融合实测会拉偏音色，默认关


# ---------- 工具 ----------
def load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def list_ref_files() -> list:
    """扫描 data/ref 下的 wav，返回 {name, path, char} 列表。"""
    refs = []
    if not REF_DIR.exists():
        return refs
    for f in sorted(REF_DIR.glob("*.wav")):
        # 文件名约定：<角色名>_<编号>.wav，如 setsuna_03.wav
        char = f.stem.rsplit("_", 1)[0]
        refs.append({
            "name": f.stem,
            "path": str(f),
            "char": char,
        })
    return refs


def default_ref_file():
    """默认参考音频：data/ref 下的第一段 wav。"""
    files = sorted(REF_DIR.glob("*.wav")) if REF_DIR.exists() else []
    return files[0] if files else None


MODEL_NAMES_FILE = DATA_DIR / "models.json"      # 用户自定义的模型名字


def load_model_names() -> dict:
    """读取用户给模型起的名字：{权重文件名: 显示名}。"""
    try:
        if MODEL_NAMES_FILE.exists():
            return json.loads(MODEL_NAMES_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def save_model_names(names: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_NAMES_FILE.write_text(json.dumps(names, ensure_ascii=False, indent=2), encoding="utf-8")


def list_models() -> list:
    """
    扫描 GPT-SoVITS 的权重目录，列出可用的训练模型。
    不写死在配置里 —— 目录里有什么就显示什么。
    命名约定：SoVITS 文件名里的 _eN_ 就是训练轮数（如 setsuna_light_e2_s362.pth → e2）。
    用户可以给模型改名，名字存在 data/models.json 里。
    """
    custom = load_model_names()
    models = []
    if SOVITS_WEIGHTS_DIR.exists():
        for f in sorted(SOVITS_WEIGHTS_DIR.glob("*.pth")):
            m = re.search(r"_e(\d+)_", f.name)
            if not m:
                continue
            epoch = int(m.group(1))
            default_name = f"e{epoch}"
            models.append({
                "id": f"e{epoch}",
                "label": custom.get(f.name) or default_name,
                "name": custom.get(f.name) or default_name,
                "default_name": default_name,
                "renamed": bool(custom.get(f.name)),
                "epoch": epoch,
                "file": f.name,
            })
    return models


def find_ref_file(voice: str, tone: str) -> str:
    """找到这次合成该用的参考音频绝对路径。voice 可以是文件名，也可以是模型 id（如 e2）。"""
    if voice:
        p = REF_DIR / f"{voice}.wav"
        if p.exists():
            return str(p)
        if Path(voice).exists():
            return str(voice)
    # 兜底：用默认参考音频（界面上只选模型，不选参考音频）
    ref = default_ref_file()
    if ref is not None:
        return str(ref)
    raise HTTPException(status_code=404, detail="找不到参考音频，请把 wav 放进 data/ref/")


def ref_prompt_text(voice: str) -> str:
    """参考音频对应的文本。有的话传给引擎 —— 训练后的模型带上参考文本合成更稳。"""
    try:
        f = REF_DIR / "ref_texts.json"
        if f.exists():
            mapping = json.loads(f.read_text(encoding="utf-8"))
            return mapping.get(Path(voice).stem, "")
    except Exception:
        pass
    return ""


def aux_refs() -> list:
    """
    辅助参考音频（多段融合音色）。
    GPT-SoVITS 支持传多条参考音频，音色取平均，比单条更稳、更不容易偏。
    """
    out = []
    aux_dir = REF_DIR / "aux"
    try:
        meta = aux_dir / "aux_refs.json"
        if meta.exists():
            for item in json.loads(meta.read_text(encoding="utf-8")):
                p = aux_dir / item["file"]
                if p.exists():
                    out.append(str(p))
        elif aux_dir.exists():
            out = [str(p) for p in sorted(aux_dir.glob("*.wav"))]
    except Exception:
        pass
    return out[:4]


def merge_wavs(wav_bytes_list: list) -> bytes:
    """把多段 wav 拼成一段。要求采样率/声道/位深一致（v2 引擎固定 32k/单声道/16bit）。"""
    if len(wav_bytes_list) == 1:
        return wav_bytes_list[0]

    frames = []
    params = None
    for b in wav_bytes_list:
        with wave.open(io.BytesIO(b), "rb") as w:
            if params is None:
                params = w.getparams()
            frames.append(w.readframes(w.getnframes()))

    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setparams(params)
        for fr in frames:
            w.writeframes(fr)
    return out.getvalue()


# ---------- 接口 ----------
@app.get("/api/health")
def health():
    """健康检查。engine_up=声音引擎活着；translator_up=本地翻译（Ollama）活着。"""
    return {
        "status": "ok",
        "engine_up": is_engine_up(),
        "translator_up": is_translator_up(),
    }


@app.get("/api/models")
def models():
    """可用的训练模型（从权重目录扫出来，目录里有什么就显示什么）。"""
    ms = list_models()
    return {
        "models": ms,
        "active": ms[0]["id"] if ms else None,
    }


class RenameModelRequest(BaseModel):
    file: str          # 权重文件名，如 setsuna_light_e2_s362.pth
    name: str = ""     # 新名字；留空 = 恢复默认 eN


@app.post("/api/models/rename")
def rename_model(req: RenameModelRequest):
    """
    给模型改名（比如 e2 → 我的声音）。
    名字存在 data/models.json，不改权重文件名，随时可以改回来。
    """
    if SOVITS_WEIGHTS_DIR is None or not (SOVITS_WEIGHTS_DIR / req.file).exists():
        raise HTTPException(status_code=404, detail="找不到这个模型文件")

    new_name = (req.name or "").strip()
    if len(new_name) > 24:
        raise HTTPException(status_code=400, detail="名字太长了，24 个字以内")
    # 过滤掉奇怪字符，只留中英文数字和少量符号
    if new_name and not re.match(r"^[\w\u4e00-\u9fa5 ·\-\.（）()]+$", new_name):
        raise HTTPException(status_code=400, detail="名字里有不支持的字符")

    names = load_model_names()
    if new_name:
        names[req.file] = new_name
    else:
        names.pop(req.file, None)     # 空名字 = 恢复默认
    save_model_names(names)

    # 返回改名后的模型信息
    for m in list_models():
        if m["file"] == req.file:
            return {"ok": True, "model": m}
    return {"ok": True}


@app.get("/api/voices")
def voices():
    """
    界面上的"选择模型"列表。
    现在用户只选模型，不选参考音频：每个模型对应一条默认参考音频。
    """
    ref = default_ref_file()
    if ref is None:
        return {"voices": []}
    ms = list_models()
    if not ms:
        # 没有训练权重：返回默认参考音频，当作零样本克隆
        return {"voices": [{"name": "default", "label": "default", "char": "default", "path": str(ref)}]}
    return {
        "voices": [
            {"name": m["id"], "label": m["label"], "display": m["name"], "char": "model",
             "path": str(ref), "epoch": m["epoch"], "file": m["file"]}
            for m in ms
        ]
    }


@app.get("/api/preview")
def preview(voice: str):
    """试听参考音频：voice 是文件名（如 setsuna_03）或完整路径，返回 wav 流。"""
    try:
        ref_path = find_ref_file(voice, "")
    except HTTPException:
        raise HTTPException(status_code=404, detail=f"找不到参考音频：{voice}")
    if not Path(ref_path).exists():
        raise HTTPException(status_code=404, detail="参考音频不存在")
    return FileResponse(ref_path, media_type="audio/wav")


@app.post("/api/synthesize")
def synthesize_text(req: SynthesizeRequest):
    """
    合成一段语音。

    流程：
      1. 如果「输入语言」≠「输出语言」，先用本地 Qwen3 翻译
      2. 按输出语言切句
      3. 逐句调引擎合成 -> 拼接 -> 存盘
    """
    raw_text = (req.text or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="文案是空的，先写点东西吧")

    lang = req.lang if req.lang in ("ja", "zh", "en") else "ja"
    input_lang = req.input_lang if req.input_lang in ("ja", "zh", "en") else lang

    # ---------- 翻译（输入语言 ≠ 输出语言时）----------
    translated_text = raw_text
    translated = False
    translate_engine = ""
    if input_lang != lang:
        try:
            translated_text, translate_engine = translate_with_engine(raw_text, input_lang, lang)
            translated = True
        except TranslateError as e:
            raise HTTPException(status_code=503, detail=str(e))
        if not translated_text.strip():
            raise HTTPException(status_code=503, detail="翻译结果为空，请再试一次")

    text = translated_text

    # 语气：自动就先判断，否则直接用用户选的（兼容前端的 'auto' 哨兵值）
    tone = req.tone
    if tone in ("自动", "auto") or tone not in TONES:
        tone = judge_tone(text, lang)["tone"]
        tone_auto = True
    else:
        tone_auto = False

    # 参考音频（v1：语气先只影响返回字段，参考音频还是选 voice 本身；
    # 后续有按语气挑片段的库再升级 find_ref_file 逻辑）
    ref_path = find_ref_file(req.voice, tone)

    # 切句
    sentences = split_sentences(text, lang)
    seg_count = len(sentences)

    # 输出目录：outputs/<时间戳>/
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_dir = OUTPUT_DIR / stamp
    job_dir.mkdir(parents=True, exist_ok=True)

    started = time.time()
    segments = []
    wavs = []

    # 整段一次交给引擎：引擎自己按句子（cut3/cut4）切分并处理接缝，
    # 比我们"逐句合成再拼接"自然得多 —— 拼接会产生 1 秒以上的怪停顿。
    if lang == "en":
        split_method = "cut4"      # 英文按 . 切
    else:
        split_method = "cut3"      # 中日文按 。 切

    try:
        wav_bytes = synthesize(
            text=text,
            text_lang=lang,
            ref_audio_path=ref_path,
            prompt_lang=lang,
            prompt_text=ref_prompt_text(ref_path),
            speed_factor=req.speed,
            seed=req.seed,
            temperature=req.temperature,
            top_k=req.top_k,
            repetition_penalty=req.repetition_penalty,
            aux_ref_audio_paths=aux_refs() if req.use_aux_ref else None,
            text_split_method=split_method,
            fragment_interval=0.15,
        )
    except EngineError as e:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=503, detail=str(e))

    full_name = "full.wav"
    (job_dir / full_name).write_bytes(wav_bytes)
    wavs = [wav_bytes]

    # 段落信息仅用于展示/统计（音频是引擎一次生成的整体）
    for i, sent in enumerate(sentences, 1):
        segments.append({
            "index": i,
            "text": sent,
        })

    # 记录这次合成的元信息（历史里要用）
    meta = {
        "time": stamp,
        "text": text,                      # 实际拿去合成的文本（翻译后的）
        "original_text": raw_text,         # 用户原始输入
        "input_lang": input_lang,
        "translated": translated,
        "lang": lang,
        "voice": req.voice,
        "tone": tone,
        "tone_auto": tone_auto,
        "segments": len(segments),
        "elapsed_ms": int((time.time() - started) * 1000),
        "est_seconds": estimate_seconds(text),
        "seed": req.seed,
        "temperature": req.temperature,
        "top_k": req.top_k,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    (job_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "ok": True,
        "audio_url": f"/static/output/{stamp}/{full_name}",
        "segments": segments,
        "tone": tone,
        "tone_auto": tone_auto,
        "elapsed_ms": meta["elapsed_ms"],
        "seed": req.seed,
        "created_at": meta["created_at"],
        "original_text": raw_text,
        "translated_text": text,
        "translated": translated,
        "translated_by": translate_engine,   # qwen / builtin / none
        "input_lang": input_lang,
        "output_lang": lang,
    }


@app.get("/api/history")
def history():
    """最近 20 条合成记录（只认有 meta.json 的真正合成记录，子目录如 ab_test 不算）。"""
    items = []
    if OUTPUT_DIR.exists():
        for job_dir in sorted(OUTPUT_DIR.iterdir(), reverse=True):
            if not job_dir.is_dir():
                continue
            meta_file = job_dir / "meta.json"
            # 没有 meta.json 的目录（比如手动放的对比样本）不算历史记录
            if not meta_file.exists():
                continue
            meta = {}
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except Exception:
                pass
            full = job_dir / "full.wav"
            items.append({
                "time": job_dir.name,
                "text": meta.get("text", ""),
                "lang": meta.get("lang", ""),
                "voice": meta.get("voice", ""),
                "tone": meta.get("tone", ""),
                "audio_url": f"/static/output/{job_dir.name}/full.wav" if full.exists() else None,
                "elapsed_ms": meta.get("elapsed_ms", 0),
                "seed": meta.get("seed", -1),
                "created_at": meta.get("created_at", ""),
            })
            if len(items) >= 20:
                break
    return {"history": items}


def _safe_job_dir(stamp: str) -> Path:
    """校验历史条目名，防止路径穿越（只能删 outputs 下、真正的合成记录目录）。"""
    name = (stamp or "").strip().replace("\\", "/")
    if not name or "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="历史记录名不合法")
    target = (OUTPUT_DIR / name).resolve()
    if OUTPUT_DIR.resolve() not in target.parents:
        raise HTTPException(status_code=400, detail="历史记录名不合法")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="这条历史记录不存在（可能已删除）")
    # 只允许删真正的合成记录（有 meta.json），避免误删手动放入的对比样本
    if not (target / "meta.json").exists():
        raise HTTPException(status_code=400, detail="这不是一条合成记录，不能从这里删除")
    return target


@app.delete("/api/history/{stamp}")
def delete_history_item(stamp: str):
    """删除一条合成历史（连同它的音频文件一起删）。"""
    target = _safe_job_dir(stamp)
    shutil.rmtree(target, ignore_errors=True)
    if target.exists():
        raise HTTPException(status_code=500, detail="删除失败，文件可能正被占用")
    return {"ok": True, "deleted": stamp}


@app.delete("/api/history")
def clear_history():
    """清空全部合成历史。"""
    count = 0
    if OUTPUT_DIR.exists():
        for job_dir in list(OUTPUT_DIR.iterdir()):
            if job_dir.is_dir():
                shutil.rmtree(job_dir, ignore_errors=True)
                if not job_dir.exists():
                    count += 1
    return {"ok": True, "deleted_count": count}


@app.post("/api/serve")
def serve_info():
    """静态托管状态（前端页面 + 合成产物都挂在 /static 下）。"""
    return {
        "mounted": True,
        "frontend": "/static -> /src/static",
        "output": "/static/output -> outputs",
    }


# ============================================================
# 训练：一键开练（后台跑，界面可看进度）
# ============================================================
class TrainStartRequest(BaseModel):
    epochs_s2: int = 6      # 音色模型轮数
    epochs_s1: int = 8      # 韵律模型轮数
    batch_s2: int = 2       # 音色模型批量（8G 显存建议 2）
    batch_s1: int = 4       # 韵律模型批量


class ScanSourceRequest(BaseModel):
    path: str


class ImportSourceRequest(BaseModel):
    path: str
    max_samples: int = 800


@app.get("/api/data/status")
def data_status():
    """训练数据现状。"""
    return data_prep.current_dataset()


@app.post("/api/data/scan")
def data_scan(req: ScanSourceRequest):
    """扫描一个文件夹里的音频（只读元数据，不动文件）。"""
    try:
        return {"ok": True, **data_prep.scan_source(req.path)}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except NotADirectoryError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/data/import")
def data_import(req: ImportSourceRequest):
    """把音频导入成训练用 wav（后台转换，有进度）。"""
    res = data_prep.start_import(req.path, req.max_samples)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("message", "导入失败"))
    return res


@app.post("/api/data/prepare")
def data_prepare():
    """语音识别 + 清洗（后台跑，比较久）。"""
    res = data_prep.start_prepare()
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("message", "启动失败"))
    return res


@app.get("/api/data/job")
def data_job():
    """导入/识别的实时进度。"""
    return data_prep.job_status()


@app.get("/api/train/data")
def train_data():
    """训练数据概览。"""
    return trainer.dataset_summary()


@app.get("/api/train/status")
def train_status():
    """训练进度 + 最近日志。"""
    return trainer.status()


@app.post("/api/train/start")
def train_start(req: TrainStartRequest):
    """开始训练（后台跑，不卡界面）。"""
    e2 = max(1, min(20, int(req.epochs_s2)))
    e1 = max(1, min(30, int(req.epochs_s1)))
    b2 = max(1, min(8, int(req.batch_s2)))
    b1 = max(1, min(16, int(req.batch_s1)))
    res = trainer.start(epochs_s2=e2, epochs_s1=e1, batch_s2=b2, batch_s1=b1)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("message", "启动失败"))
    return res


@app.post("/api/train/stop")
def train_stop():
    """停止训练。"""
    res = trainer.stop()
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("message", "停止失败"))
    return res


# ============================================================
# 评测：用声纹模型给"像不像"打分
# ============================================================
EVAL_DIR = OUTPUT_DIR / "_eval"              # 评测产物放这里（不影响合成历史）
EVAL_HISTORY = DATA_DIR / "evaluations.json"  # 评测历史记录

# 固定的测试句（跨语言用）
CROSS_LANG_TESTS = {
    "zh": [
        "你好，今天过得怎么样？",
        "我一直在这里等你回来。",
        "这种事情，我绝对不会原谅。",
    ],
    "en": [
        "Good morning. How are you today?",
        "I have been waiting for you all this time.",
        "I will never forgive you for this.",
    ],
}


def _sample_ja_tests(n: int = 5) -> list:
    """从训练数据里挑测试句（本人语言）。挑长度适中的，避免太短。"""
    clean_list = DATA_DIR / "setsuna" / "setsuna_clean.list"
    texts = []
    try:
        for line in clean_list.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            parts = line.split("|")
            if len(parts) != 4:
                continue
            t = parts[3].strip()
            if 8 <= len(t) <= 30:
                texts.append(t)
    except Exception:
        pass
    if not texts:
        # 兜底：固定句子
        texts = ["おはよう。今日もいい天気だね。", "ずっと、あなたのことが好きだったの。"]
    # 均匀抽样，保证稳定（同一批测试句方便多次对比）
    step = max(1, len(texts) // n)
    picked = texts[::step][:n]
    return picked


def _load_eval_history() -> list:
    try:
        if EVAL_HISTORY.exists():
            return json.loads(EVAL_HISTORY.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []


def _save_eval_history(items: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    EVAL_HISTORY.write_text(json.dumps(items[-50:], ensure_ascii=False, indent=2), encoding="utf-8")


def _eval_one_sentence(text: str, lang: str, ref_path: str) -> dict:
    """合成一句并打分。"""
    wav_bytes = synthesize(
        text=text,
        text_lang=lang,
        ref_audio_path=ref_path,
        prompt_lang="ja",
        prompt_text=ref_prompt_text(ref_path),
        speed_factor=1.0,
        temperature=0.8,
        top_k=10,
        repetition_penalty=1.2,
    )
    return wav_bytes


@app.get("/api/evaluate/tests")
def evaluate_tests():
    """当前使用的测试句（前端展示用）。"""
    return {
        "ja": _sample_ja_tests(5),
        "cross": CROSS_LANG_TESTS,
    }


@app.post("/api/evaluate")
def run_evaluate():
    """
    跑一次评测：用当前模型合成测试句，跟参考音频比声纹相似度。
    返回每句得分 + 分语言平均分 + 总评。
    """
    if not evaluator.is_available():
        raise HTTPException(status_code=503, detail="声纹模型不可用，没法打分")

    ref = default_ref_file()
    if ref is None:
        raise HTTPException(status_code=400, detail="没有参考音频，没法打分")
    ref = str(ref)

    ms = list_models()
    model_name = ms[0]["name"] if ms else "默认"

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_dir = EVAL_DIR / stamp
    job_dir.mkdir(parents=True, exist_ok=True)

    # 测试句：本人语言（日文）用训练数据里的句子；另外测中文、英文（跨语言）
    test_sets = {"ja": _sample_ja_tests(5)}
    test_sets.update(CROSS_LANG_TESTS)

    try:
        ref_emb = evaluator.embedding(ref)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"参考音频打不开：{e}")

    details = []
    scores_by_lang = {}
    idx = 0
    for lang, texts in test_sets.items():
        for t in texts:
            idx += 1
            try:
                wav_bytes = _eval_one_sentence(t, lang, ref)
            except EngineError as e:
                raise HTTPException(status_code=503, detail=str(e))
            wav_path = job_dir / f"{idx:02d}_{lang}.wav"
            wav_path.write_bytes(wav_bytes)
            try:
                emb = evaluator.embedding(str(wav_path))
                score = evaluator.cosine(ref_emb, emb)
            except Exception:
                score = None
            item = {
                "index": idx,
                "lang": lang,
                "text": t,
                "score": round(score, 4) if score is not None else None,
                "level": evaluator.level_of(score) if score is not None else "无法评分",
                "audio_url": f"/static/output/_eval/{stamp}/{wav_path.name}",
            }
            details.append(item)
            if score is not None:
                scores_by_lang.setdefault(lang, []).append(score)

    def avg(xs):
        return round(sum(xs) / len(xs), 4) if xs else None

    summary = {lang: {"avg": avg(v), "count": len(v)} for lang, v in scores_by_lang.items()}
    main_avg = summary.get("ja", {}).get("avg")
    overall = avg([s for v in scores_by_lang.values() for s in v])

    record = {
        "time": stamp,
        "model": model_name,
        "overall": overall,
        "level": evaluator.level_of(overall) if overall is not None else "无",
        "main": main_avg,
        "by_lang": summary,
        "details": details,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }

    hist = _load_eval_history()
    hist.append(record)
    _save_eval_history(hist)

    return {"ok": True, "result": record}


@app.get("/api/evaluations")
def list_evaluations():
    """评测历史（最近的在前）。"""
    hist = _load_eval_history()
    return {"evaluations": list(reversed(hist[-20:]))}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
