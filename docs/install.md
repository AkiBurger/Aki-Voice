# 安装与启动

本文覆盖从零准备环境到打开界面的完整步骤。默认按 Windows 10/11 + NVIDIA 显卡编写。

## 一、准备目录

默认目录关系如下（也可以放到别处，用环境变量指定）：

```
<根目录>\
├── ai\
│   └── 02_GPT-SoVITS_配音\        ← GPT-SoVITS 所在目录（名字随意）
│       ├── .venv\                 ← GPT-SoVITS 的 Python 环境
│       └── GPT-SoVITS\
│           ├── api_v2.py
│           ├── GPT_SoVITS\pretrained_models\   ← v2Pro 预训练模型
│           ├── SoVITS_weights_v2Pro\           ← 训练出的 .pth
│           └── GPT_weights_v2Pro\              ← 训练出的 .ckpt
├── cache\huggingface\hub\         ← HuggingFace 缓存（Fun-ASR、opus-mt）
├── projects\
│   └── voice-studio\              ← 本项目
└── tools\ffmpeg\bin\              ← ffmpeg.exe
```

如果项目不在 `<根目录>\projects\` 下，程序仍能工作，只是需要设置环境变量，见第五节。

## 一键准备脚本（可选）

不想手动下载各个组件时，可以在项目根目录用 PowerShell 运行：

```powershell
powershell -ExecutionPolicy Bypass -File tools\setup_windows.ps1
```

脚本会：

- 检查 git、Python、NVIDIA 显卡
- 缺少 GPT-SoVITS 时克隆官方仓库
- 下载 GPT-SoVITS 预训练模型（可选，约 10GB）
- 下载 ffmpeg 静态版到 `tools\ffmpeg\bin`
- 下载 Fun-ASR-Nano 和 opus-mt 翻译模型到 HuggingFace 缓存
- 把发现的路径写入用户环境变量
- 最后运行 `tools\check_env.py`

先用 `-DryRun` 只看计划、不下载：

```powershell
powershell -ExecutionPolicy Bypass -File tools\setup_windows.ps1 -DryRun
```

跳过大文件的参数：`-SkipModels`、`-SkipFunASR`、`-SkipTranslateModel`、`-SkipFFmpeg`。

脚本不安装 GPT-SoVITS 的 Python 依赖和 CUDA 驱动，这两步仍按 GPT-SoVITS 官方文档做。
下载失败时脚本会给出警告，可以手动下载后再跑一次。

## 二、准备第三方组件

### 1. GPT-SoVITS

从 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 获取代码，按它的文档：

- 创建 Python 环境（建议直接用它的 `.venv`）
- 下载 v2Pro 预训练模型，放到 `GPT_SoVITS/pretrained_models/`
- 确认 `api_v2.py` 能正常启动：

```bat
cd <根目录>\ai\<GPT-SoVITS 目录>\GPT-SoVITS
..\.venv\Scripts\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

打开 <http://127.0.0.1:9880/docs> 能看到接口文档，说明引擎就绪。首次加载模型需要 1~3 分钟。

### 2. ffmpeg

下载 Windows 版 ffmpeg，把 `ffmpeg.exe` 所在目录放到 `tools\ffmpeg\bin\`。
如果放在别处，设置环境变量 `ABV_FFMPEG_DIR` 指向该目录。

### 3. Fun-ASR-Nano（只在识别素材时需要）

从 ModelScope / HuggingFace 获取 Fun-ASR-Nano-2512，缓存到 HuggingFace 目录。
设置环境变量 `ABV_FUNASR_SNAPSHOT` 指向模型快照目录，例如：

```bat
set ABV_FUNASR_SNAPSHOT=<根目录>\cache\huggingface\hub\models--FunAudioLLM--Fun-ASR-Nano-2512\snapshots\<快照ID>
```

不设这个变量时，识别按钮会提示缺少模型，其余功能不受影响。

### 4. Ollama + Qwen3（可选）

不装也能合成，只是翻译会用内置的小模型（仅支持中→日）。
装了以后后端会优先调用 Ollama；地址和模型名可用环境变量覆盖：

```bat
set ABV_OLLAMA_URL=http://127.0.0.1:11434
set ABV_OLLAMA_MODEL=qwen3
```

## 三、安装本项目

```bat
git clone https://github.com/AkiBurger/voice-studio.git
cd voice-studio
copy config.example.json config.json
```

依赖安装有两种方式：

**方式 A（推荐）**：直接使用 GPT-SoVITS 的 venv，依赖通常已经齐全，跳过 pip。

**方式 B**：自建 Python 3.10+ 环境：

```bat
pip install -r requirements.txt
```

> 已经用 GPT-SoVITS venv 时，不要再 `pip install` torch / transformers，以免覆盖和 CUDA 匹配的版本。
> `requirements.txt` 是版本下限，实际以 GPT-SoVITS 环境为准。

### FunASR

识别功能需要 `funasr` 包。它随 GPT-SoVITS 的 venv 一起安装；如果缺失：

```bat
<GPT-SoVITS 的 venv>\Scripts\pip.exe install funasr
```

## 四、启动

### 方式 1：启动器（推荐）

1. 编译或获取 `AkiBurgerVoice.exe`，放到项目根目录
2. 双击运行

启动器会依次检查环境、启动引擎（9880）、挂载权重、启动后端（8017）、打开浏览器。
支持高 DPI、单实例；失败会显示原因，可以重试或打开日志。

编译启动器（需要 Windows 自带的 .NET Framework 4.x）：

```bat
cd launcher
build.bat
```

产物在项目根目录。目录不同时，用环境变量指定，见第五节。

### 方式 2：手动启动

开两个终端：

```bat
:: 终端 1：引擎
cd <根目录>\ai\<GPT-SoVITS 目录>\GPT-SoVITS
..\.venv\Scripts\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml

:: 终端 2：后端
cd <项目目录>
<GPT-SoVITS 的 venv>\Scripts\python.exe src\backend\app.py
```

浏览器打开 <http://127.0.0.1:8017>。

## 五、路径与环境变量

程序默认按第五节开头的目录关系查找；不符合时用环境变量覆盖：

| 变量 | 作用 | 默认 |
|---|---|---|
| `ABV_PROJECT_ROOT` | 项目根目录（启动器用） | exe 所在目录 |
| `ABV_AI_ROOT` | 存放 GPT-SoVITS 的上级目录 | 项目上两级目录下的 `ai` |
| `ABV_SOVITS_ROOT` | 直接指定 `GPT-SoVITS` 目录 | 在 `ABV_AI_ROOT` 下自动找 |
| `ABV_FFMPEG_DIR` | ffmpeg.exe 所在目录 | `<AI 根目录>\..\tools\ffmpeg\bin` |
| `ABV_HF_CACHE` | HuggingFace 缓存目录 | `<AI 根目录>\..\cache\huggingface\hub` |
| `ABV_ENGINE_URL` | 引擎地址 | `http://127.0.0.1:9880` |
| `ABV_OLLAMA_URL` | Ollama 地址 | `http://127.0.0.1:11434` |
| `ABV_OLLAMA_MODEL` | Ollama 翻译模型 | `qwen3` |
| `ABV_TRANSLATE_ENGINE` | 翻译引擎选择 | 自动 |
| `ABV_FUNASR_SNAPSHOT` | Fun-ASR 模型快照目录 | 无 |
| `ABV_FROM_SCRATCH` | 训练是否从零开始（`0` 表示续训） | `1` |
| `ABV_EXP_NAME` | 训练实验名 | `voice_light` |

启动器相关的调试变量（`ABV_LAUNCHER_*`）只用于自动化截图，正常使用不需要设置。

## 六、第一次运行检查

```bat
:: 后端和引擎都已启动的情况下
<venv>\Scripts\python.exe src\backend\selftest.py
```

结果写到 `data/_selftest.txt`，正常应为 15 项全部通过。

如果只看到界面但合成失败，先看 [troubleshooting.md](troubleshooting.md#引擎起不来)。

## 七、更新

```bat
git pull
```

如果启动器源码有变化，重新执行 `launcher\build.bat`；前端没有构建步骤，刷新浏览器即可。

## 八、数据位置

- 训练素材和标注：`data/voice/`（自动创建）
- 参考音频：`data/ref/`
- 模型注册表和音色名：`data/models.json`、`data/voice.json`
- 合成结果：`outputs/`
- 日志：`logs/`
- 训练权重：GPT-SoVITS 下的 `SoVITS_weights_v2Pro/`、`GPT_weights_v2Pro/`

这些都不会进入 Git。换电脑时请自行备份。
