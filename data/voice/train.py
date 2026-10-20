# -*- coding: utf-8 -*-
"""
轻量版训练脚本（v2Pro）。

一条龙做完：
  1. 数据集制作：文字特征 → hubert特征 → 音色特征 → 语义token
  2. SoVITS 微调（学音色）
  3. GPT 微调（学韵律）

参数按 8GB 显存压低（batch 小、轮数少、开梯度检查点）。
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml

sys.stdout.reconfigure(encoding="utf-8")

# ---------- 路径 ----------
def _resolve_sovits_root() -> Path:
    env = os.environ.get("ABV_SOVITS_ROOT", "").strip()
    if env:
        return Path(env)
    project = Path(__file__).resolve().parents[2]
    ai = Path(os.environ.get("ABV_AI_ROOT", str(project.parent.parent / "ai")))
    if ai.exists():
        for item in sorted(ai.glob("*GPT-SoVITS*")):
            if (item / "GPT-SoVITS" / "api_v2.py").exists():
                return item / "GPT-SoVITS"
    return ai / "GPT-SoVITS"

SOVITS_ROOT = _resolve_sovits_root()
PY = sys.executable
DATA = Path(__file__).resolve().parent
LIST = DATA / f"{DATA.name}.list"
WAV_DIR = DATA / "wav"

EXP = os.environ.get("ABV_EXP_NAME", "voice_light")   # 实验名，产物在 logs/<EXP>
VERSION = "v2Pro"
OPT_DIR = SOVITS_ROOT / "logs" / EXP

# 用清洗后的数据（剔除病态识别文本，见 clean_data.py）
CLEAN_LIST = DATA / f"{DATA.name}_clean.list"

# 预处理版本戳：记录 clean.list 与 wav 列表的指纹，
# 素材一变就重算受影响的特征，不再"只看文件存不存在"
PREP_STAMP = DATA / ".prep_stamp.json"

# 从零训练开关：
# 默认 1。=1 时训练前把旧的 s1/s2 训练产物移进备份目录，从预训练底模开始。
# 想续训就设 ABV_FROM_SCRATCH=0。
FROM_SCRATCH = os.environ.get("ABV_FROM_SCRATCH", "1") == "1"

# 旧训练产物备份根目录（在 logs/ 下，不删除，只挪走）
BACKUP_ROOT = OPT_DIR / "_backups"

BERT = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
CNHUBERT = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
SV = "GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt"
S2G = "GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth"
S2D = "GPT_SoVITS/pretrained_models/v2Pro/s2Dv2Pro.pth"
S1 = "GPT_SoVITS/pretrained_models/s1v3.ckpt"

# ---------- 轻量参数（可在界面里改，通过环境变量传入）----------
S2_BATCH = int(os.environ.get("ABV_S2_BATCH", "2"))    # 8G 显存推荐 2
S2_EPOCHS = int(os.environ.get("ABV_S2_EPOCHS", "6"))  # 轻量：常规 8，这里 6
S2_SAVE_EVERY = int(os.environ.get("ABV_S2_SAVE_EVERY", "2"))
S1_BATCH = int(os.environ.get("ABV_S1_BATCH", "4"))
S1_EPOCHS = int(os.environ.get("ABV_S1_EPOCHS", "8"))  # 轻量：常规 15，这里 8
S1_SAVE_EVERY = int(os.environ.get("ABV_S1_SAVE_EVERY", "4"))
# 学习率（可选：不填就用配置默认值）
S2_LR = os.environ.get("ABV_S2_LR", "").strip()
S1_LR = os.environ.get("ABV_S1_LR", "").strip()

GPU = "0"
_half = "True"


def run_step(title, script, env_extra, retries=2):
    """跑一个子步骤。偶发的 Windows 文件读竞态（tokenize 报怪错）重试即可恢复。"""
    print(f"\n{'='*60}\n== {title}\n{'='*60}", flush=True)
    for attempt in range(1, retries + 1):
        env = os.environ.copy()
        env.update({k: str(v) for k, v in env_extra.items()})
        t0 = time.time()
        p = subprocess.run([PY, "-s", script], cwd=str(SOVITS_ROOT), env=env)
        dt = (time.time() - t0) / 60
        if p.returncode == 0:
            print(f"[OK] {title} 完成，用时 {dt:.1f} 分钟", flush=True)
            return
        print(f"[注意] 第 {attempt} 次失败（返回码 {p.returncode}），{'重试...' if attempt < retries else '已达最大重试次数'}",
              flush=True)
        time.sleep(3)
    sys.exit(f"[失败] {title} 失败（已重试 {retries} 次）")


def _now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _move_to_backup(src: Path, backup_dir: Path, tag: str):
    """把 src 挪进 logs/_backups/<时间戳>/<tag>/ 下。挪不了就退化成重命名。"""
    try:
        dst = backup_dir / tag / src.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        print(f"  ↦ 已备份: {src.name} → {dst.relative_to(BACKUP_ROOT)}", flush=True)
    except OSError as e:
        # 跨盘/占用时 move 可能失败，重命名到同目录下也算"挪走"
        renamed = src.with_name(f"{src.name}.backup_{_now_stamp()}")
        try:
            src.rename(renamed)
            print(f"  ↦ 已改名避让: {src.name} → {renamed.name}（{e}）", flush=True)
        except OSError:
            print(f"  [注意] 无法移动 {src.name}：{e}", flush=True)


def backup_old_training_artifacts(from_scratch: bool):
    """
    训练前清理旧训练产物：

    1. 二次训练崩溃：s1_train 会自动加载 logs_s1_<版本>/ckpt 里的旧 checkpoint，
       torch.load 报 "Weights only load failed: WindowsPath"。
       → 旧 ckpt 目录必须挪走（不删，进 _backups）。
    2. 二次训练秒完成：s2_train 会自动找 logs_s2_<版本>/D_*.pth、G_*.pth 续训，
       指定轮数直接失效。
       → 从零模式（默认）把 D_/G_ 也挪走。

    续训模式（ABV_FROM_SCRATCH=0）只保留 s2 的 D_/G_，什么都不动。
    """
    if not from_scratch:
        print("== 续训模式：保留旧 checkpoint，从上次进度继续 ==", flush=True)
        return
    print("== 从零训练：先备份旧训练产物（不删除） ==", flush=True)
    stamp = _now_stamp()
    backup_dir = BACKUP_ROOT / stamp
    moved_any = False

    # s1（GPT）的旧 checkpoint —— 不挪走 torch.load 必崩
    s1_dir = OPT_DIR / f"logs_s1_{VERSION}"
    ckpt = s1_dir / "ckpt"
    if ckpt.exists() and any(ckpt.iterdir()):
        _move_to_backup(ckpt, backup_dir, "s1_ckpt")
        moved_any = True
    # s1 的 lightning 版本日志（version_0/1/2…），挪走避免 version 无限增长
    inner = s1_dir / f"logs_s1_{VERSION}"
    if inner.exists():
        for vdir in sorted(inner.glob("version_*")):
            _move_to_backup(vdir, backup_dir, "s1_versions")
            moved_any = True

    # s2（SoVITS）的续训点：D_*.pth / G_*.pth
    s2_dir = OPT_DIR / f"logs_s2_{VERSION}"
    if s2_dir.exists():
        for pat in ("D_*.pth", "G_*.pth"):
            for f in sorted(s2_dir.glob(pat)):
                _move_to_backup(f, backup_dir, "s2_ckpt")
                moved_any = True

    if moved_any:
        print("== 备份完成，本次从预训练底模开始训练 ==", flush=True)
    else:
        print("== 没有旧产物，直接从预训练底模开始 ==", flush=True)


def _compute_prep_hash() -> str:
    """算素材指纹：clean.list 全文 + wav 文件名/大小列表。"""
    h = hashlib.sha256()
    if CLEAN_LIST.exists():
        h.update(CLEAN_LIST.read_bytes())
    else:
        h.update(b"NO_CLEAN_LIST")
    for w in sorted(WAV_DIR.glob("*.wav")):
        try:
            h.update(f"{w.name}|{w.stat().st_size}".encode("utf-8"))
        except OSError:
            h.update(w.name.encode("utf-8"))
    return h.hexdigest()


def check_prep_stamp() -> str:
    """
    对比 .prep_stamp.json 与当前素材指纹。

    返回:
        "fresh"  首次运行（没有戳）
        "match"  指纹一致，特征产物可以直接复用
        "stale"  指纹变了，需要清掉受影响的特征产物重算
    """
    now_hash = _compute_prep_hash()
    if not PREP_STAMP.exists():
        return "fresh"
    try:
        old = json.loads(PREP_STAMP.read_text(encoding="utf-8"))
        return "match" if old.get("hash") == now_hash else "stale"
    except Exception:
        return "stale"


def save_prep_stamp():
    """把当前素材指纹写进 .prep_stamp.json。"""
    payload = {
        "hash": _compute_prep_hash(),
        "updated_at": _now_stamp(),
        "clean_list": str(CLEAN_LIST),
        "wav_dir": str(WAV_DIR),
    }
    PREP_STAMP.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def clear_stale_prep_products():
    """
    素材变了：清掉所有受影响的特征产物，强制重算。

    清单（与 prep_dataset 产出对应）：
      2-name2text*.txt / 3-bert / 4-cnhubert / 5-wav32k /
      6-name2semantic*.tsv / 7-sv_cn
    合并产物（merge_parts 生成）也要删，否则会拿旧的合并文件训练。
    """
    print("[注意] 素材指纹变了：清掉受影响的特征产物，准备重算", flush=True)
    targets = [
        "2-name2text-0.txt", "2-name2text.txt",
        "6-name2semantic-0.tsv", "6-name2semantic.tsv",
    ]
    for name in targets:
        p = OPT_DIR / name
        if p.exists():
            p.unlink()
            print(f"  ↦ 已删除 {name}", flush=True)
    for dname in ("3-bert", "4-cnhubert", "5-wav32k", "7-sv_cn"):
        d = OPT_DIR / dname
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
            print(f"  ↦ 已删除目录 {dname}", flush=True)


def prep_dataset():
    """数据集制作四步（v2Pro 需要额外的音色特征提取）。"""
    if not CLEAN_LIST.exists():
        sys.exit(f"[失败] 找不到清洗后的数据 {CLEAN_LIST}，先跑 clean_data.py")
    data_list = CLEAN_LIST

    lines = [l for l in data_list.read_text(encoding="utf-8").splitlines() if l.strip()]
    print(f"训练样本：{len(lines)} 条（已清洗）")
    OPT_DIR.mkdir(parents=True, exist_ok=True)

    # 素材指纹检查：改了标注/加了素材 → 清掉旧特征重算；没变才跳过
    stamp_state = check_prep_stamp()
    if stamp_state == "stale":
        clear_stale_prep_products()
    print(f"预处理产物状态：{stamp_state}（{'素材没变，可复用' if stamp_state == 'match' else '将（重）算特征'}）", flush=True)

    base = {
        "inp_text": str(data_list),
        "inp_wav_dir": str(WAV_DIR),
        "exp_name": EXP,
        "opt_dir": str(OPT_DIR),
        "i_part": "0",
        "all_parts": "1",
        "_CUDA_VISIBLE_DEVICES": GPU,
    }

    # 1) 文字 → BERT 特征
    if not (OPT_DIR / "2-name2text-0.txt").exists() and not (OPT_DIR / "2-name2text.txt").exists():
        run_step("1/4 提取文字特征", "GPT_SoVITS/prepare_datasets/1-get-text.py",
                 {**base, "bert_pretrained_dir": BERT, "is_half": _half})
    else:
        print("跳过 1/4（已有产物）", flush=True)

    # 2) 音频 → hubert 特征
    if not (OPT_DIR / "4-cnhubert").exists():
        run_step("2/4 提取音频特征", "GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py",
                 {**base, "cnhubert_base_dir": CNHUBERT, "sv_path": SV})
    else:
        print("跳过 2/4（已有产物）", flush=True)

    # 2.5) v2Pro 额外：音色特征
    if not (OPT_DIR / "7-sv_cn").exists():
        run_step("2.5/4 提取音色特征（v2Pro 专用）", "GPT_SoVITS/prepare_datasets/2-get-sv.py",
                 {**base, "cnhubert_base_dir": CNHUBERT, "sv_path": SV})
    else:
        print("跳过 2.5/4（已有产物）", flush=True)

    # 3) 语义 token
    if not (OPT_DIR / "6-name2semantic-0.tsv").exists() and not (OPT_DIR / "6-name2semantic.tsv").exists():
        s2config = f"GPT_SoVITS/configs/s2{VERSION}.json"
        run_step("3/4 提取语义 token", "GPT_SoVITS/prepare_datasets/3-get-semantic.py",
                 {**base, "pretrained_s2G": S2G, "s2config_path": s2config})
    else:
        print("跳过 3/4（已有产物）", flush=True)

    # 全部算完，把当前素材指纹记下来（下次跑时对比用）
    save_prep_stamp()


def merge_parts():
    """把分片产物合并成最终文件（webui 里是同一步，脚本里要自己做）。"""
    print(f"\n{'='*60}\n== 合并数据分片\n{'='*60}", flush=True)

    # 文字特征：2-name2text-0.txt -> 2-name2text.txt
    t0 = OPT_DIR / "2-name2text-0.txt"
    t_all = OPT_DIR / "2-name2text.txt"
    if t0.exists() and not t_all.exists():
        lines = t0.read_text(encoding="utf-8").strip("\n").split("\n")
        t_all.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[OK] 文字特征合并：{len(lines)} 行 → {t_all.name}")

    # 语义 token：6-name2semantic-0.tsv -> 6-name2semantic.tsv（要带表头）
    s0 = OPT_DIR / "6-name2semantic-0.tsv"
    s_all = OPT_DIR / "6-name2semantic.tsv"
    if s0.exists() and not s_all.exists():
        lines = s0.read_text(encoding="utf-8").strip("\n").split("\n")
        s_all.write_text("item_name\tsemantic_audio\n" + "\n".join(lines) + "\n", encoding="utf-8")
        print(f"[OK] 语义 token 合并：{len(lines)} 行 → {s_all.name}")


def train_sovits():
    """SoVITS 微调：学音色。"""
    print(f"\n{'='*60}\n== 4/5 SoVITS 微调（音色）\n{'='*60}", flush=True)
    # 从零训练：先把旧的续训点挪走，否则 s2_train 会从 D_/G_ 续训，
    # 指定轮数不生效、一轮没训就"完成"
    backup_old_training_artifacts(FROM_SCRATCH)
    cfg_path = SOVITS_ROOT / "TEMP" / "tmp_s2_light.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    # webui 会预先建好这个日志目录，s2_train 存 checkpoint 时要写进去
    (OPT_DIR / f"logs_s2_{VERSION}").mkdir(parents=True, exist_ok=True)

    src = json.loads((SOVITS_ROOT / f"GPT_SoVITS/configs/s2{VERSION}.json").read_text(encoding="utf-8"))
    src["train"].update({
        "batch_size": S2_BATCH,
        "epochs": S2_EPOCHS,
        "fp16_run": True,
        "save_every_epoch": S2_SAVE_EVERY,
    })
    if S2_LR:
        try:
            src["train"]["learning_rate"] = float(S2_LR)
        except ValueError:
            print(f"[注意] 学习率格式不对，忽略: {S2_LR}")
    src["train"].update({
        "if_save_latest": True,
        "if_save_every_weights": True,
        "pretrained_s2G": S2G,
        "pretrained_s2D": S2D,
        "grad_ckpt": True,          # 省显存
        "gpu_numbers": GPU,
        "lora_rank": "32",
    })
    src["model"]["version"] = VERSION
    src["data"]["exp_dir"] = str(OPT_DIR)
    src["s2_ckpt_dir"] = str(OPT_DIR)
    src["save_weight_dir"] = f"SoVITS_weights_{VERSION}"
    src["name"] = EXP
    src["version"] = VERSION

    # 关键：ensure_ascii=True —— 路径里有中文（02_GPT-SoVITS_配音），
    # 而 s2_train.py 用系统默认编码（GBK）读配置文件。写成 ASCII 转义最稳。
    cfg_path.write_text(json.dumps(src, ensure_ascii=True), encoding="utf-8")
    env = os.environ.copy()
    env["_CUDA_VISIBLE_DEVICES"] = GPU
    t0 = time.time()
    p = subprocess.run([PY, "-s", "GPT_SoVITS/s2_train.py", "--config", str(cfg_path)],
                       cwd=str(SOVITS_ROOT), env=env)
    if p.returncode != 0:
        sys.exit(f"[失败] SoVITS 训练失败（返回码 {p.returncode}）")
    print(f"[OK] SoVITS 训练完成，用时 {(time.time()-t0)/60:.1f} 分钟", flush=True)


def train_gpt():
    """GPT 微调：学韵律。"""
    print(f"\n{'='*60}\n== 5/5 GPT 微调（韵律）\n{'='*60}", flush=True)
    # 训练输入检查：文件缺失时给明确错误，而不是让 s1_train 空转/卡死
    for need in ("6-name2semantic.tsv", "2-name2text.txt"):
        if not (OPT_DIR / need).exists():
            sys.exit(f"[失败] 缺少训练输入 {OPT_DIR / need}，请先完整跑一次数据准备（不要只跑 gpt）")
    # 从零训练：挪走旧 ckpt —— s1_train 的 torch.load 加载旧 checkpoint
    # 会报 "Weights only load failed: WindowsPath"，不挪走二次训练必崩
    backup_old_training_artifacts(FROM_SCRATCH)
    cfg_path = SOVITS_ROOT / "TEMP" / "tmp_s1_light.yaml"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    (OPT_DIR / f"logs_s1_{VERSION}").mkdir(parents=True, exist_ok=True)
    (SOVITS_ROOT / f"GPT_weights_{VERSION}").mkdir(parents=True, exist_ok=True)

    src = yaml.load((SOVITS_ROOT / "GPT_SoVITS/configs/s1longer-v2.yaml").read_text(encoding="utf-8"),
                    Loader=yaml.FullLoader)
    src["train"].update({
        "batch_size": S1_BATCH,
        "epochs": S1_EPOCHS,
        "precision": "16-mixed",
        "save_every_n_epoch": S1_SAVE_EVERY,
        "if_save_every_weights": True,
        "if_save_latest": True,
        "if_dpo": False,
        "half_weights_save_dir": f"GPT_weights_{VERSION}",
        "exp_name": EXP,
    })
    if S1_LR:
        try:
            src["train"]["lr"] = float(S1_LR)
        except ValueError:
            print(f"[注意] 学习率格式不对，忽略: {S1_LR}")
    src["pretrained_s1"] = S1
    src["train_semantic_path"] = str(OPT_DIR / "6-name2semantic.tsv")
    src["train_phoneme_path"] = str(OPT_DIR / "2-name2text.txt")
    src["output_dir"] = str(OPT_DIR / f"logs_s1_{VERSION}")
    src["train"]["gpu_numbers"] = GPU
    # Windows 下多进程 DataLoader 是"卡死不报错"的常见来源（模型加载后 GPU 0%）。
    # 轻量训练数据量小，num_workers=0 完全够用；想调回去设 ABV_S1_NUM_WORKERS=4。
    src["data"]["num_workers"] = int(os.environ.get("ABV_S1_NUM_WORKERS", "0"))

    # 同理：YAML 也不留非 ASCII 字符，避免训练脚本按 GBK 读时中文路径乱码
    cfg_path.write_text(yaml.dump(src, default_flow_style=False, allow_unicode=False), encoding="utf-8")
    env = os.environ.copy()
    env["_CUDA_VISIBLE_DEVICES"] = GPU
    env["hz"] = "25hz"
    # 卡死诊断：启动前把关键信息打全，卡住时日志里能看出停在哪一步
    print(f"GPT 训练启动诊断：", flush=True)
    print(f"  config    = {cfg_path}", flush=True)
    print(f"  ckpt 目录 = {OPT_DIR / f'logs_s1_{VERSION}' / 'ckpt'}（旧产物已备份）", flush=True)
    print(f"  num_workers = {src['data']['num_workers']}（0=不用子进程，Windows 最稳）", flush=True)
    print(f"  epochs   = {S1_EPOCHS} / batch = {S1_BATCH}", flush=True)
    t0 = time.time()
    p = subprocess.run([PY, "-s", "GPT_SoVITS/s1_train.py", "--config_file", str(cfg_path)],
                       cwd=str(SOVITS_ROOT), env=env)
    if p.returncode != 0:
        sys.exit(f"[失败] GPT 训练失败（返回码 {p.returncode}）")
    print(f"[OK] GPT 训练完成，用时 {(time.time()-t0)/60:.1f} 分钟", flush=True)


def main():
    t_all = time.time()
    print(f"训练开始\n  数据: {LIST}\n  样本: 见下方\n  实验名: {EXP}\n  版本: {VERSION}")
    prep_dataset()
    merge_parts()
    train_sovits()
    train_gpt()

    # 汇报产物
    print(f"\n{'='*60}\n== 训练结束，总用时 {(time.time()-t_all)/60:.1f} 分钟\n{'='*60}")
    for d in (SOVITS_ROOT / f"SoVITS_weights_{VERSION}", SOVITS_ROOT / f"GPT_weights_{VERSION}"):
        print(f"\n{d.name}:")
        if d.exists():
            for f in sorted(d.glob(f"{EXP}*")):
                print(f"  {f.name}  ({f.stat().st_size/1e6:.1f} MB)")
        else:
            print("  （目录不存在）")


if __name__ == "__main__":
    # 支持单独跑某一段：python train.py gpt / python train.py sovits
    step = sys.argv[1].lower() if len(sys.argv) > 1 else ""
    if step == "gpt":
        prep_dataset()   # 素材可能变过，先按指纹检查/重算特征，避免"拿旧数据空转"
        merge_parts()
        train_gpt()
    elif step == "sovits":
        prep_dataset()
        merge_parts()
        train_sovits()
    else:
        main()
