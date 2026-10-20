# -*- coding: utf-8 -*-
"""
AkiBurger Voice 后端服务。

职责：
- 给前端提供 /api/* 接口
- 代理 GPT-SoVITS 引擎（默认 127.0.0.1:9880）
- 长文本交给引擎按句切分合成，产出 wav 和历史记录
- 静态托管：前端页面 + 合成产物

启动：
    python src/backend/app.py

监听 127.0.0.1:8017
"""
import io
import json
import os
import random
import re
import threading
import shutil
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from engine import EngineError, is_engine_up, set_models, synthesize
from emotion import judge_tone, TONES
from text_split import estimate_seconds, split_sentences
from translate import TranslateError, is_translator_up, translate, translate_with_engine

import evaluate as evaluator   # 声纹打分（评测用）
import trainer
import data_prep
import folder_picker             # 文件夹选择框
import qc
import annotate

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

_synth_lock = threading.Lock()        # 同一时间只跑一个合成（防并发抢显存）
_eval_lock = threading.Lock()          # 评测互斥
_synth_busy_since = None               # 当前合成开始时间（/api/synth/status 用）


# ---------- 参数校验错误中文化 ----------
# 前端字段名 → 中文名；Pydantic 422 的报错翻译成人话（保留 422 状态码）
FIELD_CN = {
    "epochs_s2": "音色轮数", "epochs_s1": "韵律轮数",
    "batch_s2": "音色批量", "batch_s1": "韵律批量",
    "lr_s2": "音色学习率", "lr_s1": "韵律学习率",
    "save_every_s2": "音色保存间隔", "save_every_s1": "韵律保存间隔",
    "speed": "语速", "seed": "随机种子", "temperature": "变化度",
    "top_k": "采样范围", "repetition_penalty": "重复惩罚",
    "text": "文案", "lang": "输出语言", "input_lang": "输入语言",
    "voice": "模型", "ref": "参考音频", "tone": "语气",
    "auto_eval": "自动评测", "from_scratch": "训练方式",
    "time": "时间", "name": "名字", "file": "文件名",
    "max_samples": "导入数量", "all": "全部",
    "path": "路径", "wav": "音频", "batch": "回收批次",
}


def _translate_validation_msg(msg: str, field_cn: str) -> str:
    """把 Pydantic v2 的英文校验信息翻成中文人话。"""
    m = re.search(r"greater than or equal to ([\d.]+)", msg)
    if m:
        return f"{field_cn}不能小于 {m.group(1)}"
    m = re.search(r"less than or equal to ([\d.]+)", msg)
    if m:
        return f"{field_cn}不能大于 {m.group(1)}"
    m = re.search(r"greater than ([\d.]+)", msg)
    if m:
        return f"{field_cn}必须大于 {m.group(1)}"
    m = re.search(r"less than ([\d.]+)", msg)
    if m:
        return f"{field_cn}必须小于 {m.group(1)}"
    if "valid integer" in msg:
        return f"{field_cn}必须是整数"
    if "valid number" in msg or "finite number" in msg:
        return f"{field_cn}必须是数字"
    if "required" in msg:
        return f"缺少参数：{field_cn}"
    if "string_too_long" in msg or "too long" in msg:
        return f"{field_cn}太长了"
    return f"{field_cn}参数不合法（{msg[:60]}）"


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """422 中文化：detail 直接给可读的中文句子，状态码保持 422。"""
    parts = []
    for err in exc.errors():
        loc = list(err.get("loc", []))
        field = str(loc[-1]) if loc else "参数"
        if loc and loc[0] == "body" and field not in FIELD_CN:
            pass  # 不在映射里的字段用原名
        cn = FIELD_CN.get(field, field)
        parts.append(_translate_validation_msg(err.get("msg", ""), cn))
    return JSONResponse(status_code=422, content={"detail": "；".join(parts) or "参数不合法"})


@app.get("/", include_in_schema=False)
def root_redirect():
    """直接访问 127.0.0.1:8017 时跳到前端页面。"""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/index.html")


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


# ---------- 本机访问守卫（防 CSRF / DNS rebinding）----------
# 只接受本机 Host；跨站 POST/DELETE 一律拒绝（浏览器发 Origin/Sec-Fetch-Site 时校验）。
ALLOWED_HOSTS = {"127.0.0.1:8017", "localhost:8017"}
ALLOWED_ORIGINS = {"http://127.0.0.1:8017", "http://localhost:8017"}


@app.middleware("http")
async def guard_local_only(request, call_next):
    host = (request.headers.get("host") or "").lower()
    if host and host not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "只允许本机访问 127.0.0.1"}, status_code=403)
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        origin = (request.headers.get("origin") or "").rstrip("/")
        if origin and origin.lower() not in ALLOWED_ORIGINS:
            return JSONResponse({"detail": "跨站请求被拒绝"}, status_code=403)
        site = request.headers.get("sec-fetch-site")
        if site and site not in ("same-origin", "none"):
            return JSONResponse({"detail": "跨站请求被拒绝"}, status_code=403)
    return await call_next(request)


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
    ref: str = ""                       # 指定参考音频（data/ref 下的文件名，如 hist_xxx）；留空=按现有逻辑挑
    tone: str = "自动"                  # 平静|开心|悲伤|生气|惊讶|害怕|自动
    # 参数范围限制（防止非法值把引擎/显存搞挂，也让 422 报错即时返回）：
    speed: float = Field(default=1.0, ge=0.5, le=2.0)             # 语速
    seed: int = Field(default=-1, ge=-1)                          # -1 随机；指定数字可复现
    temperature: float = Field(default=0.8, ge=0.1, le=2.0)       # 越低越稳
    top_k: int = Field(default=10, ge=1, le=100)                  # 采样范围，越小越稳
    repetition_penalty: float = Field(default=1.2, ge=0.5, le=2.0)  # 防念重复/卡壳
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
    """
    默认参考音频：优先非 hist_ 前缀的（真实来源的参考），否则 data/ref 下第一段 wav。

    为什么要排除 hist_：从历史固化的参考是按字母序排的（h < s），
    会让"合成结果"反客为主变成默认参考；默认参考不该是一段合成产物。
    """
    files = sorted(REF_DIR.glob("*.wav")) if REF_DIR.exists() else []
    real = [f for f in files if not f.stem.startswith("hist_")]
    pool = real or files
    return pool[0] if pool else None


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
    if SOVITS_WEIGHTS_DIR is not None and SOVITS_WEIGHTS_DIR.exists():
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


def _inside_ref_dir(p: Path) -> bool:
    """路径是否真的在 data/ref 里面（防路径穿越）。"""
    try:
        rp = p.resolve()
        return REF_DIR.resolve() in rp.parents
    except Exception:
        return False


def _pick_gpt_file(epoch: int):
    """挑和这个轮次匹配的 GPT 权重；没有就取最新的。"""
    if GPT_WEIGHTS_DIR is None or not GPT_WEIGHTS_DIR.exists():
        return None
    files = list(GPT_WEIGHTS_DIR.glob("*.ckpt"))
    if not files:
        return None
    for f in files:
        if f"-e{epoch}" in f.name or f"_e{epoch}" in f.name:
            return f.name
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0].name


def switch_model_if_needed(voice: str) -> None:
    """
    如果界面选的是某个模型（如 e2），把引擎权重切到它。
    """
    if not voice:
        return
    m = None
    for item in list_models():
        if voice in (item["id"], item["name"], item["file"]):
            m = item
            break
    if m is None:
        return
    try:
        set_models(f"SoVITS_weights_v2Pro/{m['file']}", f"GPT_weights_v2Pro/{_pick_gpt_file(m['epoch'])}"
                   if _pick_gpt_file(m["epoch"]) else "")
    except EngineError as e:
        # 切不过去就明确报错，别让用户以为用的是选中的模型
        raise EngineError(f"切换到模型 {m.get('name') or m['file']} 失败：{e}") from e


def find_ref_file(voice: str, tone: str = "") -> str:
    """
    找到这次合成该用的参考音频绝对路径。

    只允许 data/ref 目录下的 wav；voice 可以是文件名或模型 id（走默认参考音频），
    不接受任意本地路径。
    """
    if voice:
        # 1) 按文件名找（去掉可能的目录部分，不用用户给的路径本身）
        p = REF_DIR / f"{Path(voice).name}.wav"
        if p.exists() and _inside_ref_dir(p):
            return str(p)

        # 2) 内部调用会传绝对路径：只接受 data/ref 里的 wav
        try:
            cand = Path(voice)
            if cand.is_absolute() and cand.suffix.lower() == ".wav" and cand.exists() and _inside_ref_dir(cand):
                return str(cand.resolve())
        except Exception:
            pass

    # 兜底：用默认参考音频（界面上只选模型，不选参考音频）
    ref = default_ref_file()
    if ref is not None and _inside_ref_dir(ref):
        return str(ref)
    raise HTTPException(status_code=404, detail="找不到参考音频，请把 wav 放进 data/ref/")


TONES_DIR = REF_DIR / "tones"
_tone_map_cache = None


def tone_ref(tone: str):
    """按语气取参考音频：返回 (路径, 参考文本)；没有配置就返回 None。"""
    global _tone_map_cache
    if _tone_map_cache is None:
        try:
            f = TONES_DIR / "tones.json"
            _tone_map_cache = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
        except Exception:
            _tone_map_cache = {}
    for item in _tone_map_cache.get(tone, []):
        path = TONES_DIR / item.get("file", "")
        if path.exists() and _inside_ref_dir(path):
            return str(path), item.get("text", "")
    return None


_tone_build_lock = threading.Lock()
_tone_build_done = False


def build_tones_if_missing() -> bool:
    """
    语气库没有生成过时，从清洗列表里自动挑一次参考音频。

    做法：按 judge_tone 把 setsuna_clean.list 里的句子分到 6 种语气，
    每种语气挑最典型的 2 段，把 wav 复制进 data/ref/tones/<语气>/，
    写入 tones.json。之后合成选语气时就能自动挑到对应参考音频，
    不会静默回退到默认参考。

    只跑一次（_tone_build_done 防重入）；失败也不阻断合成。
    """
    global _tone_build_done
    if _tone_build_done or (TONES_DIR / "tones.json").exists():
        return True
    with _tone_build_lock:
        if _tone_build_done or (TONES_DIR / "tones.json").exists():
            return True
        clean = DATA_DIR / "setsuna" / "setsuna_clean.list"
        if not clean.exists():
            _tone_build_done = True       # 没数据，不反复试
            return False
        picked = {t: [] for t in TONES}
        try:
            for line in clean.read_text(encoding="utf-8").splitlines():
                parts = line.split("|")
                if len(parts) != 4:
                    continue
                wav_path, _spk, _lang, text = parts
                p = Path(wav_path)
                if not p.exists() or not text.strip():
                    continue
                tone = judge_tone(text, "ja")["tone"]
                if tone not in picked or len(picked[tone]) >= 2:
                    continue
                picked[tone].append((p, text.strip()))
        except Exception:
            _tone_build_done = True
            return False
        if not any(picked.values()):
            _tone_build_done = True
            return False
        try:
            TONES_DIR.mkdir(parents=True, exist_ok=True)
            mapping = {}
            for tone, items in picked.items():
                if not items:
                    continue
                tone_dir = TONES_DIR / tone
                tone_dir.mkdir(parents=True, exist_ok=True)
                entries = []
                for i, (src, text) in enumerate(items, 1):
                    dst = tone_dir / f"sample{i}.wav"
                    if not dst.exists():
                        shutil.copy2(str(src), str(dst))
                    entries.append({"file": f"{tone}/sample{i}.wav", "text": text})
                mapping[tone] = entries
            (TONES_DIR / "tones.json").write_text(
                json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
            global _tone_map_cache
            _tone_map_cache = mapping
        except Exception:
            pass
        _tone_build_done = True
        return bool(_tone_map_cache)


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


# ---- 参考音频的元信息（从历史固化的 ref 会记在这里）----
REF_META_FILE = REF_DIR / "ref_meta.json"


def _load_ref_meta() -> dict:
    """读 data/ref/ref_meta.json → {stem: {text, source, created_at, model, tone, lang, duration}}"""
    try:
        if REF_META_FILE.exists():
            return json.loads(REF_META_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_ref_meta(mapping: dict) -> None:
    REF_DIR.mkdir(parents=True, exist_ok=True)
    REF_META_FILE.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")


def _ref_text_for_stem(stem: str) -> str:
    """取某个参考音频的文本：优先 ref_meta.json，其次 ref_texts.json。"""
    meta = _load_ref_meta().get(stem, {})
    if meta.get("text"):
        return meta["text"]
    return ref_prompt_text(stem)


def _ref_stem_from_name(name: str) -> str:
    """把请求里的参考音频名规整成 stem（去目录、去 .wav 后缀）。"""
    stem = Path((name or "").strip().replace("\\", "/")).name
    if stem.lower().endswith(".wav"):
        stem = stem[:-4]
    return stem


def _resolve_explicit_ref(name: str):
    """
    把请求指定的参考音频解析成 (路径, 文本, stem)。
    只允许 data/ref 下的 wav；找不到抛 404。
    """
    stem = _ref_stem_from_name(name)
    if not stem:
        raise HTTPException(status_code=400, detail="参考音频名字不合法")
    p = REF_DIR / f"{stem}.wav"
    if not p.exists() or not _inside_ref_dir(p):
        raise HTTPException(status_code=404, detail=f"找不到这个参考音频：{stem}")
    return str(p), _ref_text_for_stem(stem), stem


def _guess_prompt_lang(text: str) -> str:
    """
    猜参考音频/参考文本的语言，给 prompt_lang 用。

    启发式（够用即可）：
    - 含假名 → ja
    - 含汉字 → zh
    - 纯 ASCII → en
    - 拿不准（空文本等）→ ja（当前语气库/参考库全是日文，这是安全的默认）

    以前这里硬编码 "ja"：只要参考音频全是日文就没问题，
    但将来混入中文/英文参考音频就会把 prompt_lang 传错。加这个启发式防患。
    """
    t = (text or "").strip()
    if not t:
        return "ja"
    if re.search(r"[\u3040-\u30ff]", t):        # 平假名/片假名
        return "ja"
    if re.search(r"[\u4e00-\u9fff]", t):        # 汉字
        return "zh"
    if re.fullmatch(r"[\x20-\x7e]+", t):        # 纯 ASCII
        return "en"
    return "ja"


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


class ToneRequest(BaseModel):
    text: str
    lang: str = "ja"


@app.post("/api/tone")
def judge_tone_api(req: ToneRequest):
    """判断文本语气（前端输入停顿后调用）。"""
    try:
        return judge_tone(req.text or "", req.lang if req.lang in ("ja", "zh", "en") else "ja")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)[:100])


@app.post("/api/tones/build")
def tones_build():
    """
    手动重建语气库：从清洗列表里按语气挑参考音频，写进 data/ref/tones/。
    平时合成前会自动调用（缺才建），这个接口给想手动刷新的人用。
    """
    # 强制重建：清掉缓存，重新加载现有 tones.json（没有才从清洗列表生成）
    global _tone_map_cache, _tone_build_done
    _tone_map_cache = None
    _tone_build_done = False
    ok = build_tones_if_missing()
    if not ok and not (TONES_DIR / "tones.json").exists():
        raise HTTPException(status_code=400, detail="没有可用的清洗数据，生成不了语气库（先导入并完成识别清洗）")
    # 语气库已存在时 build 提前返回，这里把缓存补加载上
    if _tone_map_cache is None:
        try:
            _tone_map_cache = json.loads((TONES_DIR / "tones.json").read_text(encoding="utf-8"))
        except Exception:
            _tone_map_cache = {}
    return {"ok": True, "tones": sorted((_tone_map_cache or {}).keys())}


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
    """试听参考音频：只允许 data/ref 下登记的 wav（不再能读任意文件）。"""
    # 严格模式：给了 voice 就必须能找到（模型 id 会映射到默认参考音频），不静默回退
    if voice:
        cand = REF_DIR / f"{Path(voice).name}.wav"
        is_model = any(m["id"] == voice or m["name"] == voice for m in list_models())
        if not ((cand.exists() and _inside_ref_dir(cand)) or is_model):
            raise HTTPException(status_code=404, detail=f"找不到参考音频：{voice}")
    try:
        ref_path = find_ref_file(voice, "")
    except HTTPException:
        raise HTTPException(status_code=404, detail=f"找不到参考音频：{voice}")
    p = Path(ref_path)
    if not p.exists() or not _inside_ref_dir(p):
        raise HTTPException(status_code=404, detail="参考音频不存在")
    return FileResponse(str(p), media_type="audio/wav")


# ============================================================
# 参考音频管理：把历史里满意的合成结果固化成参考音频
# ============================================================
class RefFromHistoryRequest(BaseModel):
    time: str          # 历史目录名，如 20261020_000538


@app.post("/api/ref/from-history")
def ref_from_history(req: RefFromHistoryRequest):
    """
    把一条合成历史固化成参考音频。

    做法：
    - outputs/<time>/full.wav 复制成 data/ref/hist_<time>.wav（重复调用直接覆盖，幂等）
    - 文本取该历史 meta.json 里的 text（跨语言合成时是目标语言的文本）
    - 元信息写 ref_meta.json，并同步 ref_texts.json，保证 ref_prompt_text 能取到
    """
    t = (req.time or "").strip()
    if not re.fullmatch(r"\d{8}_\d{6}", t):
        raise HTTPException(status_code=400, detail="时间格式不对，应为 YYYYMMDD_HHMMSS")
    job_dir = OUTPUT_DIR / t
    if not job_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"找不到这条历史记录：{t}")
    src = job_dir / "full.wav"
    meta_file = job_dir / "meta.json"
    if not src.exists() or not meta_file.exists():
        raise HTTPException(status_code=400, detail="这条历史记录缺少音频或元信息，没法固化")
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="历史元信息读不出来")

    stem = f"hist_{t}"
    dst = REF_DIR / f"{stem}.wav"

    # 引擎硬性要求参考音频 3~10 秒（实测 2.91s 会被引擎 400 拒绝）。
    # 超范围直接拒绝保存（简单可靠），不让用户固化出一条合成必失败的参考。
    duration = None
    try:
        import soundfile as sf
        info = sf.info(str(src))
        duration = round(info.frames / info.samplerate, 2)
    except Exception:
        pass
    if duration is not None and not (3.0 <= duration <= 10.0):
        raise HTTPException(status_code=400, detail=(
            f"这段只有 {duration} 秒，引擎要求参考音频在 3~10 秒，换一条时长合适的历史再固化"))

    REF_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(dst))      # 覆盖式复制，幂等

    text = (meta.get("text") or "").strip()
    entry = {
        "text": text,
        "source": "history",
        "created_at": meta.get("created_at") or datetime.now().isoformat(timespec="seconds"),
        "model": meta.get("voice", ""),
        "tone": meta.get("tone", ""),
        "lang": meta.get("lang", ""),
        "duration": duration,
    }

    ref_meta = _load_ref_meta()
    ref_meta[stem] = entry
    _save_ref_meta(ref_meta)

    # 同步 ref_texts.json（ref_prompt_text 读它）
    try:
        texts_path = REF_DIR / "ref_texts.json"
        texts = json.loads(texts_path.read_text(encoding="utf-8")) if texts_path.exists() else {}
        texts[stem] = text
        texts_path.write_text(json.dumps(texts, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

    return {
        "ok": True,
        "ref": {
            "name": stem,
            "text": text,
            "duration": duration,
            "lang": entry["lang"],
            "model": entry["model"],
            "tone": entry["tone"],
        },
        "warning": "",   # 时长已在保存前校验（3~10 秒），这里恒为空，保留字段兼容
    }


@app.get("/api/refs")
def list_refs():
    """
    可用的参考音频列表（含从历史固化的）。
    扫描 data/ref 下第一层 wav（不递归，tones/aux 子目录不算），
    合并 ref_meta.json 与 ref_texts.json，按 created_at 倒序（历史生成的排前面）。
    """
    meta_map = _load_ref_meta()
    try:
        texts_path = REF_DIR / "ref_texts.json"
        texts_map = json.loads(texts_path.read_text(encoding="utf-8")) if texts_path.exists() else {}
    except Exception:
        texts_map = {}
    refs = []
    for f in sorted(REF_DIR.glob("*.wav")):
        stem = f.stem
        m = meta_map.get(stem, {})
        refs.append({
            "name": stem,
            "text": m.get("text") or texts_map.get(stem, ""),
            "source": m.get("source", "file"),
            "created_at": m.get("created_at", ""),
            "lang": m.get("lang", ""),
            "model": m.get("model", ""),
            "tone": m.get("tone", ""),
            "duration": m.get("duration"),
        })
    refs.sort(key=lambda x: x["created_at"] or "", reverse=True)
    default = default_ref_file()
    return {"refs": refs, "default": default.stem if default else ""}


class RefDeleteRequest(BaseModel):
    name: str = ""


@app.post("/api/refs/delete")
def delete_ref(req: RefDeleteRequest):
    """
    删除一个参考音频（wav + ref_meta + ref_texts 条目一起清）。
    只允许 data/ref 下的 .wav；当前默认参考不能删。
    """
    stem = _ref_stem_from_name(req.name)
    if not stem:
        raise HTTPException(status_code=400, detail="参考音频名字不合法")
    p = REF_DIR / f"{stem}.wav"
    if not p.exists() or not _inside_ref_dir(p):
        raise HTTPException(status_code=404, detail=f"找不到这个参考音频：{stem}")
    default = default_ref_file()
    if default is not None and default.stem == stem:
        raise HTTPException(status_code=400, detail="这是当前默认参考音频，不能删除（先换一个默认参考）")

    p.unlink(missing_ok=True)
    meta_map = _load_ref_meta()
    meta_map.pop(stem, None)
    _save_ref_meta(meta_map)
    try:
        texts_path = REF_DIR / "ref_texts.json"
        if texts_path.exists():
            texts = json.loads(texts_path.read_text(encoding="utf-8"))
            texts.pop(stem, None)
            texts_path.write_text(json.dumps(texts, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True, "deleted": stem}


@app.post("/api/synthesize")
def synthesize_text(req: SynthesizeRequest):
    """
    合成一段语音。

    输入语言和输出语言不同时先翻译，然后把整段文本交给引擎按句切分合成，
    结果存到 outputs/<时间戳>/ 并写入历史。
    """
    raw_text = (req.text or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="文案是空的，先写点东西吧")
    if len(raw_text) > 5000:
        raise HTTPException(status_code=400, detail=f"文本太长了（{len(raw_text)} 字），单次最多 5000 字，请分段合成")
    # 同一时间只跑一个合成，避免并发抢显存
    # 锁被占时区分原因：评测也拿 _synth_lock，给前端不同的提示文案
    if not _synth_lock.acquire(blocking=False):
        if _eval_lock.locked():
            raise HTTPException(status_code=429, detail="评测进行中，等它跑完再合成")
        raise HTTPException(status_code=429, detail="正在合成上一段，等它完成再点")
    global _synth_busy_since
    _synth_busy_since = datetime.now().isoformat(timespec="seconds")
    try:
        return _do_synthesize(req, raw_text)
    finally:
        _synth_lock.release()
        _synth_busy_since = None


def _do_synthesize(req: "SynthesizeRequest", raw_text: str):
    started = time.time()
    lang = req.lang if req.lang in ("ja", "zh", "en") else "ja"
    input_lang = req.input_lang if req.input_lang in ("ja", "zh", "en") else lang

    # 界面选的是哪个模型，就把引擎权重切过去（有 _attached 缓存，重复切换无副作用）
    try:
        switch_model_if_needed(req.voice)
    except EngineError as e:
        raise HTTPException(status_code=503, detail=str(e))
    # 语气库不存在就自动生成一次（新用户第一次合成不再静默回退默认参考）
    build_tones_if_missing()

    # seed 处理：-1（随机）时生成一个实际种子并回显，让用户能复现这次结果
    used_seed = req.seed if req.seed >= 0 else random.randint(0, 999999)

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

    # 参考音频：
    # 1) 请求指定了 ref（历史固化的参考音频）→ 直接用，跳过语气库
    # 2) 没指定 → 按语气自动挑一条（用户直接指定了参考文件名时除外）
    ref_used_name = ""
    if req.ref:
        ref_path, ref_text, ref_used_name = _resolve_explicit_ref(req.ref)
    else:
        ref_path = find_ref_file(req.voice, tone)
        ref_text = ref_prompt_text(ref_path)
        # 只有用户没指定具体参考音频文件时，才用语气参考音频
        try:
            specified_ref = bool(req.voice) and (REF_DIR / f"{Path(req.voice).name}.wav").exists()
        except Exception:
            specified_ref = False
        if not specified_ref:
            picked = tone_ref(tone)
            if picked:
                ref_path, ref_text = picked

    # 切句
    sentences = split_sentences(text, lang)
    seg_count = len(sentences)

    # 输出目录：outputs/<时间戳>/
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_dir = OUTPUT_DIR / stamp
    job_dir.mkdir(parents=True, exist_ok=True)

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
            prompt_lang=_guess_prompt_lang(ref_text),   # 按参考文本猜语言，不再硬编码 ja
            prompt_text=ref_text,
            speed_factor=req.speed,
            seed=used_seed,
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
        "ref": Path(ref_path).name,
        "ref_used": ref_used_name or Path(ref_path).name,   # 实际使用的参考音频文件名
        "segments": len(segments),
        "elapsed_ms": int((time.time() - started) * 1000),
        "est_seconds": estimate_seconds(text),
        "seed": used_seed,                 # 实际使用的种子（-1 已被替换成真种子）
        "seed_requested": req.seed,
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
        "seed": used_seed,                 # 向后兼容（合成时传的是实际种子）
        "seed_used": used_seed,            # 新增：实际使用的种子，可复现
        "seed_requested": req.seed,
        "lang": lang,                      # 新增：输出语言（前端直接读）
        "output_lang": lang,               # 兼容旧字段
        "ref_used": meta["ref_used"],      # 新增：实际使用的参考音频文件名
        "created_at": meta["created_at"],
        "original_text": raw_text,
        "translated_text": text,
        "translated": translated,
        "translated_by": translate_engine,   # qwen / builtin / none
        "input_lang": input_lang,
    }


@app.get("/api/synth/status")
def synth_status():
    """
    合成忙状态（前端在批量停止后轮询，等服务端收尾）。
    只读、无副作用：busy = _synth_lock 是否被占（合成或评测都在用它）。
    """
    return {
        "busy": _synth_lock.locked(),
        "since": _synth_busy_since,
        "reason": "评测" if (_synth_lock.locked() and _eval_lock.locked()) else
                  ("合成" if _synth_lock.locked() else ""),
    }


@app.get("/api/history")
def history():
    """最近 20 条合成记录（只认有 meta.json 的真正合成记录，子目录如 ab_test 不算）。"""
    valid_dirs = []
    if OUTPUT_DIR.exists():
        for job_dir in OUTPUT_DIR.iterdir():
            if job_dir.is_dir() and (job_dir / "meta.json").exists():
                valid_dirs.append(job_dir)
    valid_dirs.sort(reverse=True)
    total = len(valid_dirs)

    items = []
    for job_dir in valid_dirs[:20]:
        meta = {}
        try:
            meta = json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))
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
    return {"history": items, "total": total}


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
    """
    清空合成历史。
    只删带 meta.json 的真正合成记录，不碰 outputs/_eval（评测音频）、
    _compare（对比样本）等非合成目录。
    """
    count = 0
    if OUTPUT_DIR.exists():
        for job_dir in list(OUTPUT_DIR.iterdir()):
            if not job_dir.is_dir():
                continue
            if not (job_dir / "meta.json").exists():
                continue          # 不是合成记录，跳过
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
# 素材 / 质检 / 标注（流程前三步）
# ============================================================
class MaterialDeleteRequest(BaseModel):
    name: str = ""
    all: bool = False


class MaterialRestoreRequest(BaseModel):
    batch: str = ""     # 留空 = 恢复最近一次删除


class AnnotationSaveRequest(BaseModel):
    wav: str
    text: str


@app.post("/api/dialog/folder")
def dialog_folder():
    """弹出 Windows 文件夹选择框，返回选中的路径（用户取消返回空）。"""
    res = folder_picker.pick_folder()
    if res.get("error"):
        raise HTTPException(status_code=500, detail=res["error"])
    return res


@app.get("/api/material/list")
def material_list():
    """已导入的素材列表。"""
    return data_prep.list_materials()


@app.post("/api/material/restore")
def material_restore(req: MaterialRestoreRequest):
    """从回收站恢复素材。"""
    try:
        return data_prep.restore_materials(req.batch)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/material/trash")
def material_trash():
    """回收站批次列表。"""
    return {"batches": data_prep.trash_batches()}


@app.get("/api/material/audio")
def material_audio(name: str):
    """试听已导入的素材（只允许 wav 目录下的 .wav 文件）。"""
    p = data_prep.WAV_DIR / Path(name).name
    if p.suffix.lower() != ".wav" or not p.is_file():
        raise HTTPException(status_code=404, detail="找不到这个音频")
    return FileResponse(str(p), media_type="audio/wav")


@app.post("/api/material/delete")
def material_delete(req: MaterialDeleteRequest):
    """删除素材（按名字或全部）。"""
    try:
        return data_prep.delete_materials(req.name, req.all)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.post("/api/qc/run")
def qc_run():
    """跑质检（音频 + 标注文本）。"""
    try:
        return {"ok": True, "report": qc.run_qc()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"质检失败：{e}")


@app.delete("/api/qc/report")
def qc_clear():
    """清空质检结果（切模型/换数据时用）。"""
    try:
        if qc.REPORT_FILE.exists():
            qc.REPORT_FILE.unlink()
    except Exception:
        pass
    return {"ok": True}


@app.get("/api/qc/report")
def qc_report():
    """上一次质检报告。"""
    return qc.load_report()


@app.get("/api/annotation/list")
def annotation_list():
    """标注列表（音频 + 文本）。"""
    data = annotate.load_entries()
    data["stats"] = annotate.stats()
    return data


@app.post("/api/annotation/save")
def annotation_save(req: AnnotationSaveRequest):
    """保存一条标注文本。"""
    try:
        return annotate.save_text(req.wav, req.text)
    except (FileNotFoundError, ValueError, KeyError) as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================================
# 训练：一键开练（后台跑，界面可看进度）
# ============================================================
class TrainStartRequest(BaseModel):
    # 范围限制：越界直接 422（中文化提示），不再靠接口里钳位静默改值
    # （钳位会让 epochs_s2=99 变成 20 直接开练 —— 之前就是这样误触发了训练）
    epochs_s2: int = Field(default=6, ge=1, le=20)      # 音色模型轮数
    epochs_s1: int = Field(default=8, ge=1, le=30)      # 韵律模型轮数
    batch_s2: int = Field(default=2, ge=1, le=8)        # 音色模型批量（8G 显存建议 2）
    batch_s1: int = Field(default=4, ge=1, le=16)       # 韵律模型批量
    save_every_s2: int = Field(default=2, ge=1, le=20)  # 音色每几轮存一次
    save_every_s1: int = Field(default=4, ge=1, le=30)  # 韵律每几轮存一次
    lr_s2: float = Field(default=0.0, ge=0.0, le=0.1)   # 音色学习率（0 = 用默认）
    lr_s1: float = Field(default=0.0, ge=0.0, le=0.1)   # 韵律学习率（0 = 用默认）
    auto_eval: bool = False     # 训完自动评测
    from_scratch: bool = True   # 从零训练（False = 在已有进度上续训）


class ScanSourceRequest(BaseModel):
    path: str


class ImportSourceRequest(BaseModel):
    path: str
    max_samples: int = 0      # 0 = 全部导入


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
    # 素材导入/识别还在跑时不允许开训，否则会读到半截数据
    if data_prep.is_busy():
        raise HTTPException(status_code=400, detail="素材导入/识别还在跑，等它结束再开始训练")
    # 没有可训练素材时直接拒绝（以前 clean.list 为空也能点开始，白跑一轮）
    ds = data_prep.current_dataset()
    if ds["clean_count"] == 0 or ds["wav_count"] == 0:
        raise HTTPException(status_code=400, detail="还没有可训练的素材：先导入音频并完成识别清洗，再来训练")
    e2 = max(1, min(20, int(req.epochs_s2)))
    e1 = max(1, min(30, int(req.epochs_s1)))
    b2 = max(1, min(8, int(req.batch_s2)))
    b1 = max(1, min(16, int(req.batch_s1)))
    start_kwargs = dict(
        epochs_s2=e2, epochs_s1=e1, batch_s2=b2, batch_s1=b1,
        save_every_s2=max(1, int(req.save_every_s2)),
        save_every_s1=max(1, int(req.save_every_s1)),
        lr_s2=float(req.lr_s2 or 0), lr_s1=float(req.lr_s1 or 0),
        auto_eval=bool(req.auto_eval),
    )
    res = trainer.start(**start_kwargs, from_scratch=bool(req.from_scratch))
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

# 评测进度（前端轮询 /api/eval/status 时读）
_eval_state = {
    "running": False,
    "stage": "",          # 准备参考声纹 | 合成与打分 | 完成 | 失败
    "current": 0,
    "total": 0,
    "started_at": None,
    "finished_at": None,
    "last_error": "",
}


def _load_eval_history() -> list:
    try:
        if EVAL_HISTORY.exists():
            return json.loads(EVAL_HISTORY.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []


def _save_eval_history(items: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # 原子写：先写临时文件再替换，避免写一半崩溃把评测历史清空
    tmp = EVAL_HISTORY.with_name(EVAL_HISTORY.name + ".tmp")
    tmp.write_text(json.dumps(items[-50:], ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, EVAL_HISTORY)


def _eval_one_sentence(text: str, lang: str, ref_path: str) -> dict:
    """合成一句并打分。"""
    ref_text = ref_prompt_text(ref_path)
    wav_bytes = synthesize(
        text=text,
        text_lang=lang,
        ref_audio_path=ref_path,
        prompt_lang=_guess_prompt_lang(ref_text),
        prompt_text=ref_text,
        speed_factor=1.0,
        temperature=0.8,
        top_k=10,
        repetition_penalty=1.2,
    )
    return wav_bytes


@app.get("/api/evaluate/tests")
def evaluate_tests():
    """当前使用的测试句（固定句，与训练数据无关 —— 避免评测分数虚高）。"""
    fixed = evaluator.FIXED_TEST_SENTENCES
    return {
        "ja": fixed["ja"],
        "zh": fixed["zh"],
        "en": fixed["en"],
        "cross": {"zh": fixed["zh"], "en": fixed["en"]},   # 兼容旧前端字段
        "fixed": True,
        "note": "固定评测句，不从训练数据取句（避免数据泄漏）",
    }


@app.post("/api/evaluate")
def run_evaluate():
    """
    跑一次评测：用当前模型合成测试句，跟参考音频比声纹相似度。
    返回每句得分 + 分语言平均分 + 总评。
    """
    if not evaluator.is_available():
        raise HTTPException(status_code=503, detail="声纹模型不可用，没法打分")
    # 评测互斥：并发评测会重复合成、抢显存
    if not _eval_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="已经在评测中，等这次跑完")
    try:
        return _do_evaluate()
    finally:
        _eval_lock.release()


def _do_evaluate():
    # 评测要合成 11 句，跟普通合成共用 _synth_lock 互斥：
    # 避免评测和用户合成同时抢显存（也会让两者的耗时都爆炸）
    if not _synth_lock.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="正在合成其它音频，等它完成后再评测")
    try:
        return _do_evaluate_impl()
    finally:
        _synth_lock.release()


def _do_evaluate_impl():
    ref = default_ref_file()
    if ref is None:
        raise HTTPException(status_code=400, detail="没有参考音频，没法打分")
    ref = str(ref)

    ms = list_models()
    model_name = ms[0]["name"] if ms else "默认"
    # 用当前选中的第一个模型评测（评测的就是"现在引擎挂着的模型"）
    if ms:
        try:
            switch_model_if_needed(ms[0]["id"])
        except EngineError as e:
            raise HTTPException(status_code=503, detail=str(e))

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    job_dir = EVAL_DIR / stamp
    job_dir.mkdir(parents=True, exist_ok=True)

    # 测试句：固定句（5 日文 + 3 中文 + 3 英文），不从训练集取样（避免数据泄漏）
    test_sets = {lang: list(sents) for lang, sents in evaluator.FIXED_TEST_SENTENCES.items()}

    _eval_state.update({
        "running": True, "stage": "准备参考声纹", "current": 0,
        "total": sum(len(v) for v in test_sets.values()),
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "finished_at": None, "last_error": "",
    })

    try:
        ref_emb = evaluator.embedding(ref)
    except Exception as e:
        _eval_state.update({"running": False, "stage": "失败", "last_error": str(e),
                            "finished_at": datetime.now().isoformat(timespec="seconds")})
        raise HTTPException(status_code=500, detail=f"参考音频打不开：{e}")

    details = []
    scores_by_lang = {}
    idx = 0
    _eval_state["stage"] = "合成与打分"
    try:
        for lang, texts in test_sets.items():
            for t in texts:
                idx += 1
                _eval_state["current"] = idx
                try:
                    wav_bytes = _eval_one_sentence(t, lang, ref)
                except EngineError as e:
                    _eval_state.update({"running": False, "stage": "失败", "last_error": str(e),
                                        "finished_at": datetime.now().isoformat(timespec="seconds")})
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
    finally:
        _eval_state["running"] = False
        _eval_state["finished_at"] = datetime.now().isoformat(timespec="seconds")

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

    _eval_state["stage"] = "完成"
    return {"ok": True, "result": record}


@app.get("/api/eval/status")
def eval_status():
    """评测进度（前端轮询用）：当前第几句/共几句 + 阶段。"""
    total = _eval_state["total"] or 0
    current = _eval_state["current"]
    return {
        "running": _eval_state["running"],
        "stage": _eval_state["stage"],
        "progress": {
            "current": current,
            "total": total,
            "percent": round(current * 100 / total, 1) if total else 0,
        },
        "started_at": _eval_state["started_at"],
        "finished_at": _eval_state["finished_at"],
        "last_error": _eval_state["last_error"],
    }


@app.get("/api/evaluations")
def list_evaluations():
    """评测历史（最近的在前）。"""
    hist = _load_eval_history()
    return {"evaluations": list(reversed(hist[-20:]))}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
