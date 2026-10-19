# -*- coding: utf-8 -*-
"""
训练任务管理器：在界面里一键开练。

做的事：
1. 后台启动训练脚本（data/setsuna/train.py）
2. 实时收集日志，解析出"现在在第几步"
3. 提供开始/停止/查状态
4. 训练完成后自动把新权重挂到声音引擎上

为什么放后台：训练要 30~40 分钟，不能卡住界面。
"""
import os
import re
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TRAIN_SCRIPT = PROJECT_ROOT / "data" / "setsuna" / "train.py"
LOG_DIR = PROJECT_ROOT / "logs"
SOVITS_ROOT = None
for _d in Path(r"D:\Dev\ai").glob("02_GPT-SoVITS_*"):
    if (_d / "GPT-SoVITS" / "api_v2.py").exists():
        SOVITS_ROOT = _d / "GPT-SoVITS"
        break

# 阶段名（跟 train.py 打印的标题对应）
STAGES = [
    (r"1/4 提取文字特征", "提取文字特征"),
    (r"2/4 提取音频特征", "提取音频特征"),
    (r"2\.5/4 提取音色特征", "提取音色特征"),
    (r"3/4 提取语义", "提取语义 token"),
    (r"合并数据分片", "合并数据"),
    (r"4/5 SoVITS", "训练音色模型（SoVITS）"),
    (r"5/5 GPT", "训练韵律模型（GPT）"),
    (r"训练结束", "收尾"),
]

_state = {
    "running": False,
    "proc": None,
    "started_at": None,
    "finished_at": None,
    "success": None,
    "stage": "",
    "stage_index": -1,
    "log_path": None,
    "epochs_s2": 6,
    "epochs_s1": 8,
    "last_error": "",
    "stopped_by_user": False,
    "from_scratch": True,
    # 本次训练产出的权重文件名（挂载只认这些，不用全局 mtime）
    "produced_weights": {"sv": [], "gpt": []},
    # 训练前就存在的权重名（挂载时排除掉，避免挂上旧的）
    "pre_existing_weights": {"sv": set(), "gpt": set()},
}
_lines = deque(maxlen=400)
_lock = threading.Lock()
_start_lock = threading.Lock()      # 防止连点两次"开始训练"起两份


def _reader(proc, log_path):
    """读子进程输出，收集日志并解析阶段。"""
    global _state
    try:
        with open(log_path, "a", encoding="utf-8", errors="replace") as lf:
            for raw in proc.stdout:
                line = raw.rstrip("\n")
                with _lock:
                    _lines.append(line)
                lf.write(line + "\n")
                lf.flush()
                for idx, (pat, name) in enumerate(STAGES):
                    if re.search(pat, line):
                        _state["stage"] = name
                        _state["stage_index"] = idx
                        break
    except Exception as e:
        _state["last_error"] = f"读日志出错: {e}"


def _snapshot_existing_weights() -> dict:
    """记录训练开始前已经存在的权重文件名（挂载时排除）。"""
    snap = {"sv": set(), "gpt": set()}
    if SOVITS_ROOT is None:
        return snap
    sv_dir = SOVITS_ROOT / "SoVITS_weights_v2Pro"
    gpt_dir = SOVITS_ROOT / "GPT_weights_v2Pro"
    if sv_dir.exists():
        snap["sv"] = {p.name for p in sv_dir.glob("*.pth")}
    if gpt_dir.exists():
        snap["gpt"] = {p.name for p in gpt_dir.glob("*.ckpt")}
    return snap


def _waiter(proc):
    """等子进程结束，记录结果并自动挂载新权重。"""
    code = proc.wait()
    _state["running"] = False
    _state["finished_at"] = datetime.now().isoformat(timespec="seconds")
    # 冻结 elapsed：训练结束后 status() 里 elapsed_sec 不再增长
    if _state.get("started_at"):
        try:
            _state["elapsed_final_sec"] = int(
                (datetime.fromisoformat(_state["finished_at"])
                 - datetime.fromisoformat(_state["started_at"])).total_seconds()
            )
        except Exception:
            _state["elapsed_final_sec"] = None
    if _state.get("stopped_by_user"):
        _state["success"] = False
        _state["stage"] = "已停止"
        return
    _state["success"] = (code == 0)
    _state["stage"] = "完成" if code == 0 else "失败"
    if code == 0:
        _attach_new_weights()
        if _state.get("auto_eval"):
            _auto_eval()


def _is_new_weight(path, pre_names: set, started_ts):
    """判定一个权重文件是不是本次训练产出的：新出现，或 mtime 晚于训练开始时间。"""
    if path.name not in pre_names:
        return True
    if started_ts is None:
        return False
    try:
        return path.stat().st_mtime >= started_ts
    except OSError:
        return False


def _attach_new_weights():
    """
    训练完成后把「本次训练产出的」权重挂到引擎上。

    规则：
    - 只挂本次训练新建/改写的权重文件（训练前做文件名快照 + 开始时间戳）
    - 不再按全局 mtime 取最新（会挂到别的实验或旧模型）
    - 挂载必须校验 HTTP 200，失败要写进日志
    """
    try:
        import requests
        if SOVITS_ROOT is None:
            return
        sv_dir = SOVITS_ROOT / "SoVITS_weights_v2Pro"
        gpt_dir = SOVITS_ROOT / "GPT_weights_v2Pro"

        pre = _state.get("pre_existing_weights", {"sv": set(), "gpt": set()})
        # 本次训练产出的权重 = 新出现的文件 ∪ 本次被覆盖改写的文件（mtime 晚于开始时间）
        started_ts = None
        if _state.get("started_at"):
            try:
                started_ts = datetime.fromisoformat(_state["started_at"]).timestamp()
            except Exception:
                started_ts = None

        sv_files = list(sv_dir.glob("*.pth")) if sv_dir.exists() else []
        gpt_files = list(gpt_dir.glob("*.ckpt")) if gpt_dir.exists() else []
        new_sv = sorted(p.name for p in sv_files if _is_new_weight(p, pre["sv"], started_ts))
        new_gpt = sorted(p.name for p in gpt_files if _is_new_weight(p, pre["gpt"], started_ts))

        if not new_sv and not new_gpt:
            with _lock:
                _lines.append("[自动] 没有检测到本次训练产出的权重文件，跳过挂载")
            return

        for name in new_sv:
            r = requests.get("http://127.0.0.1:9880/set_sovits_weights",
                             params={"weights_path": f"SoVITS_weights_v2Pro/{name}"}, timeout=180)
            if r.status_code == 200:
                with _lock:
                    _lines.append(f"[自动] 已挂载新音色权重: {name}")
                _state["produced_weights"]["sv"].append(name)
            else:
                with _lock:
                    _lines.append(f"[自动挂载失败] SoVITS {name}: HTTP {r.status_code}")

        for name in new_gpt:
            r = requests.get("http://127.0.0.1:9880/set_gpt_weights",
                             params={"weights_path": f"GPT_weights_v2Pro/{name}"}, timeout=180)
            if r.status_code == 200:
                with _lock:
                    _lines.append(f"[自动] 已挂载新韵律权重: {name}")
                _state["produced_weights"]["gpt"].append(name)
            else:
                with _lock:
                    _lines.append(f"[自动挂载失败] GPT {name}: HTTP {r.status_code}")
    except Exception as e:
        with _lock:
            _lines.append(f"[自动挂载失败] {e}")


def is_running() -> bool:
    p = _state.get("proc")
    return bool(_state["running"] and p is not None and p.poll() is None)


def start(epochs_s2: int = 6, epochs_s1: int = 8, batch_s2: int = 2, batch_s1: int = 4,
          save_every_s2: int = 2, save_every_s1: int = 4,
          lr_s2: float = 0.0, lr_s1: float = 0.0, auto_eval: bool = False,
          from_scratch: bool = True) -> dict:
    """
    启动训练。返回状态字典。

    from_scratch: True = 从预训练底模开始（默认，旧产物会被备份）；
                  False = 续训（ABV_FROM_SCRATCH=0，保留旧 checkpoint）。

    并发保护：_start_lock 包住"检查是否已在跑 + 启动"整段，
    连点两次/两个请求同时来，只有一个能真正启动。
    """
    with _start_lock:
        return _start_inner(epochs_s2, epochs_s1, batch_s2, batch_s1,
                            save_every_s2, save_every_s1, lr_s2, lr_s1,
                            auto_eval, from_scratch)


def _start_inner(epochs_s2, epochs_s1, batch_s2, batch_s1,
                 save_every_s2, save_every_s1, lr_s2, lr_s1,
                 auto_eval, from_scratch) -> dict:
    """start() 的实际实现（调用方必须持有 _start_lock）。"""
    if is_running():
        return {"ok": False, "message": "已经有训练在跑了"}

    if not TRAIN_SCRIPT.exists():
        return {"ok": False, "message": f"找不到训练脚本 {TRAIN_SCRIPT}"}
    clean_list = PROJECT_ROOT / "data" / "setsuna" / "setsuna_clean.list"
    if not clean_list.exists():
        return {"ok": False, "message": "还没有清洗后的训练数据，先做数据准备"}
    # 保护：清洗列表为空 / wav 目录为空都不许开训（以前空列表也能启动，白跑一轮）
    wav_dir = PROJECT_ROOT / "data" / "setsuna" / "wav"
    if not wav_dir.exists() or not any(wav_dir.glob("*.wav")):
        return {"ok": False, "message": "还没有可训练的素材（wav 目录是空的），先导入音频"}
    try:
        lines = [l for l in clean_list.read_text(encoding="utf-8").splitlines() if l.strip()]
    except OSError:
        return {"ok": False, "message": "清洗列表读不出来，先重新做识别清洗"}
    if not lines:
        return {"ok": False, "message": "还没有可训练的素材（清洗列表是空的），先做识别清洗"}

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = LOG_DIR / f"train_{stamp}.log"

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env["ABV_S2_EPOCHS"] = str(int(epochs_s2))
    env["ABV_S1_EPOCHS"] = str(int(epochs_s1))
    env["ABV_S2_BATCH"] = str(int(batch_s2))
    env["ABV_S1_BATCH"] = str(int(batch_s1))
    env["ABV_S2_SAVE_EVERY"] = str(max(1, int(save_every_s2)))
    env["ABV_S1_SAVE_EVERY"] = str(max(1, int(save_every_s1)))
    env["ABV_FROM_SCRATCH"] = "1" if from_scratch else "0"
    if lr_s2 and float(lr_s2) > 0:
        env["ABV_S2_LR"] = str(float(lr_s2))
    if lr_s1 and float(lr_s1) > 0:
        env["ABV_S1_LR"] = str(float(lr_s1))
    env["PATH"] = r"D:\Dev\tools\ffmpeg\bin;" + env.get("PATH", "")

    with _lock:
        _lines.clear()
    _state.update({
        "running": True,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "finished_at": None,
        "success": None,
        "stage": "准备中",
        "stage_index": -1,
        "log_path": str(log_path),
        "epochs_s2": int(epochs_s2),
        "epochs_s1": int(epochs_s1),
        "batch_s2": int(batch_s2),
        "batch_s1": int(batch_s1),
        "save_every_s2": int(save_every_s2),
        "save_every_s1": int(save_every_s1),
        "lr_s2": float(lr_s2 or 0),
        "lr_s1": float(lr_s1 or 0),
        "auto_eval": bool(auto_eval),
        "from_scratch": bool(from_scratch),
        "last_error": "",
        "stopped_by_user": False,
        "elapsed_final_sec": None,
        "produced_weights": {"sv": [], "gpt": []},
        "pre_existing_weights": _snapshot_existing_weights(),
    })

    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", str(TRAIN_SCRIPT)],
            cwd=str(PROJECT_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except Exception as e:
        _state["running"] = False
        _state["last_error"] = str(e)
        return {"ok": False, "message": f"启动失败：{e}"}

    _state["proc"] = proc
    threading.Thread(target=_reader, args=(proc, log_path), daemon=True).start()
    threading.Thread(target=_waiter, args=(proc,), daemon=True).start()
    return {"ok": True, "message": "训练已启动", "log": str(log_path)}


def _kill_tree(pid: int) -> None:
    """
    杀掉整个进程树。
    train.py 会再起 s2_train / s1_train 子进程，只 terminate 父进程
    会在 Windows 上留下占显存的孤儿进程。
    """
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True, timeout=30,
        )
    except Exception:
        try:
            os.kill(pid, 9)
        except Exception:
            pass


def stop() -> dict:
    """停止训练（连同所有子进程一起杀）。"""
    proc = _state.get("proc")
    if not proc or not is_running():
        return {"ok": False, "message": "当前没有训练在跑"}
    try:
        _state["stopped_by_user"] = True
        _kill_tree(proc.pid)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        _state["running"] = False
        _state["success"] = False
        _state["stage"] = "已停止"
        with _lock:
            _lines.append("[已停止] 已终止训练进程树")
        return {"ok": True, "message": "已停止训练"}
    except Exception as e:
        return {"ok": False, "message": f"停止失败：{e}"}


def status() -> dict:
    """当前训练状态 + 最近日志。"""
    # 训练结束后用冻结值；运行中实时算
    elapsed = _state.get("elapsed_final_sec")
    if elapsed is None and _state.get("started_at"):
        try:
            elapsed = int((datetime.now() - datetime.fromisoformat(_state["started_at"])).total_seconds())
        except Exception:
            elapsed = None
    with _lock:
        tail = list(_lines)[-40:]
    return {
        "running": is_running(),
        "stage": _state["stage"],
        "stage_index": _state["stage_index"],
        "total_stages": len(STAGES),
        "elapsed_sec": elapsed,
        "success": _state["success"],
        "started_at": _state["started_at"],
        "finished_at": _state["finished_at"],
        "from_scratch": _state.get("from_scratch", True),
        "produced_weights": _state.get("produced_weights", {"sv": [], "gpt": []}),
        "epochs_s2": _state["epochs_s2"],
        "epochs_s1": _state["epochs_s1"],
        "log_path": _state["log_path"],
        "last_error": _state["last_error"],
        "log_tail": tail,
    }


def dataset_summary() -> dict:
    """训练数据概览（界面上显示）。"""
    data_dir = PROJECT_ROOT / "data" / "setsuna"
    wav_dir = data_dir / "wav"
    wavs = list(wav_dir.glob("*.wav")) if wav_dir.exists() else []
    clean_list = data_dir / "setsuna_clean.list"
    clean_count = 0
    if clean_list.exists():
        clean_count = len([l for l in clean_list.read_text(encoding="utf-8").splitlines() if l.strip()])

    total_sec = 0.0
    try:
        import soundfile as sf
        for w in wavs[:400]:
            try:
                info = sf.info(str(w))
                total_sec += info.frames / info.samplerate
            except Exception:
                pass
    except Exception:
        pass

    return {
        "wav_count": len(wavs),
        "clean_count": clean_count,
        "duration_min": round(total_sec / 60, 1),
        "ready": clean_list.exists() and len(wavs) > 0,
    }


def _auto_eval():
    """训练完成后自动跑一次评测。"""
    try:
        import requests
        with _lock:
            _lines.append("[自动] 训练完成，开始自动评测…")
        r = requests.post("http://127.0.0.1:8017/api/evaluate", timeout=3600)
        if r.status_code == 200:
            res = r.json().get("result", {})
            with _lock:
                _lines.append(f"[自动] 评测完成：总评 {res.get('overall')}（{res.get('level')}）")
        else:
            with _lock:
                _lines.append(f"[自动] 评测失败：HTTP {r.status_code}")
    except Exception as e:
        with _lock:
            _lines.append(f"[自动] 评测失败：{e}")