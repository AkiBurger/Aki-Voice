# AkiBurger Voice

**基于 GPT-SoVITS v2Pro 的本地配音工作台（Windows）。**

把素材导入、质检、标注、训练、评测、合成放在同一个界面里，训练好的音色可以直接用来读中文、日文、英文台词。

## 开始之前：先准备这些

**这个仓库只包含程序代码，不包含模型、声音素材或训练数据。** 直接 git clone 下来是跑不了合成的，需要先准备：

| 必须先准备 | 用途 | 大小 | 从哪来 |
|---|---|---|---|
| **GPT-SoVITS v2Pro**（含预训练模型） | 声音合成与训练引擎 | 10GB 以上 | [官方仓库](https://github.com/RVC-Boss/GPT-SoVITS)，按它的文档下载 |
| **Python 环境** | 后端和训练脚本运行 | — | 直接用 GPT-SoVITS 自带的 venv |
| **ffmpeg** | 素材转码、音频读取 | 约 100MB | [ffmpeg.org](https://ffmpeg.org/download.html) |
| **NVIDIA 显卡** | 训练和合成 | 8GB 显存起步 | — |
| **Fun-ASR-Nano**（要训练才需要） | 把素材识别成文本 | 约 1.9GB | ModelScope / HuggingFace |

这些没准备好时，程序能打开，但合成、训练、识别会不可用。

- 完整安装步骤：[docs/install.md](docs/install.md)
- 想少走弯路：PowerShell 运行 `tools\setup_windows.ps1`，会检查并下载缺失的 GPT-SoVITS、ffmpeg、Fun-ASR 和翻译模型；加 `-DryRun` 只预览不下载
- 装好后快速自检：`python tools\check_env.py`
- 只是想体验界面：代码可以直接跑起来看空界面，不需要模型

![合成页](docs/assets/01-synthesis.png)

## 这个工具解决什么问题

做一次私有音色的配音，通常要来回切换好几个脚本：转码、识别、改标注、跑训练、看分数、再合成。
每一步都可能因为路径、格式、显存、参考音频时长卡住，而且中间产物散落一地。
这个项目把这些步骤收进一个本地网页界面，从而优化手感：

素材 → 质检 → 标注 → 训练 → 评测 → 合成
```
界面、训练脚本、后端服务都跑在本机，素材、模型、生成结果均不上传任何服务器。

## 适合谁

- 有 NVIDIA 显卡（8GB 显存起步），愿意按文档准备 GPT-SoVITS 环境的 Windows 用户
- 想训练并使用自己（或已获授权）的音色，长期做中文 / 日文 / 英文配音


## 功能

| 页面 | 能做什么 |
|---|---|
| 合成 | 写台词、选语言和语气、翻译、合成、试听、下载；A/B 对比、批量合成、预设、历史（BACKLOG） |
| 素材 | 选文件夹、扫描、导入（统一转 16k 单声道）、识别成日文、清洗病态文本 |
| 质检 | 检查时长、静音、音量、爆音、文本异常；按通过 / 警告 / 不合格筛选，可删除问题素材 |
| 标注 | 逐条核对识别文本、搜索、修改保存；只显示音频还在的可用条目 |
| 训练 | 调轮数 / 批量 / 学习率，查看阶段进度和日志；训练完成自动挂载并启用最高轮数模型 |
| 评测 | 固定 5 句日文 + 3 句中文 + 3 句英文，算声纹相似度分数，保留历史对比 |
| 设置 | 音色名称、模型管理（启用 / 改名 / 删除）、自定义背景和立绘、页面动效开关、清理空间 |

其他：

- 启动器：自动启动声音引擎和后端、加载权重、打开浏览器；支持高 DPI、单实例、失败重试
- 左下角有六步教程，第一次打开会提示当前该做哪一步
- 语气参考库：从训练素材里给 6 种语气各挑参考音频，合成时按语气切换
- 全部离线：界面字体、图片、图标都在本地

## 界面截图

| | |
|---|---|
| ![合成结果](docs/assets/07-result-waveform.png) | ![素材](docs/assets/04-materials.png) |
| ![质检](docs/assets/05-qc.png) | ![标注](docs/assets/06-annotation.png) |
| ![训练](docs/assets/02-training.png) | ![评测](docs/assets/03-evaluation.png) |

## 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| Windows | 10 / 11 64 位 | 启动器和文件夹选择框只支持 Windows |
| Python | 3.10+ | 建议直接复用 GPT-SoVITS 自带的 venv |
| GPT-SoVITS | v2Pro | 引擎和预训练模型需要单独下载，体积约几个 GB |
| ffmpeg | 7.x 可用 | 素材转码、音频读取需要 |
| NVIDIA GPU | 8GB 显存起步 | 8GB 可以训练，合成和训练不要同时跑 |
| Fun-ASR-Nano | 约 1.9GB | 只在「识别 + 清洗」时需要 |
| Ollama + Qwen3 | 可选 | 翻译更自然；不装时用内置的中→日小模型 |

完整安装步骤见 [docs/install.md](docs/install.md)。

## 安装（简述）

```bat
git clone https://github.com/AkiBurger/voice-studio.git
cd voice-studio
copy config.example.json config.json
```

前提是已经准备好 GPT-SoVITS（含 v2Pro 预训练模型）、ffmpeg 和 Python 环境。
默认按下面的目录关系自动查找：

```
<根目录>\
├── ai\<含 GPT-SoVITS 的目录>\GPT-SoVITS\
├── cache\huggingface\hub\
├── projects\voice-studio\          ← 本项目
└── tools\ffmpeg\bin\
```

目录不同也可以用环境变量指定，见 [docs/install.md](docs/install.md#五路径与环境变量)。

## 启动

1. 启动声音引擎（9880）
2. 启动后端（8017）
3. 浏览器打开 <http://127.0.0.1:8017>

有编译好的 `AkiBurgerVoice.exe` 时，双击启动器会依次完成上面三步。
命令行启动和启动器编译方式见 [docs/install.md](docs/install.md#四启动)。

## 第一次使用

1. **素材**：选一个装着人声的文件夹 → 扫描 → 导入全部音频 → 识别 + 清洗
2. **质检**：开始质检，删除不合格片段，警告的视情况处理
3. **标注**：抽查识别文本，改错字并保存（训练用的就是改后的文本）
4. **训练**：默认 6 轮音色 / 8 轮韵律；8GB 显存建议批量 2 / 4。训练完会自动启用最新模型
5. **评测**：跑一次评测，记下分数；换轮数再训一版可以对比
6. **合成**：写台词，选输入 / 输出语言和语气，点合成；结果在 LAST TAKE 面板，历史在 BACKLOG

参考音频要求 3~10 秒。默认参考音频放在 `data/ref/*.wav`，生成语气库后会按语气自动切换。

## 目录结构

```
voice-studio/
├─ src/backend/         FastAPI 后端（8017）
├─ src/static/          纯静态前端（无构建步骤）
├─ data/voice/          训练脚本（跟踪）与本机素材（不跟踪）
├─ data/ref/            参考音频（不跟踪）
├─ launcher/            启动器源码
├─ docs/                文档与截图
├─ tools/               自检脚本
├─ config.example.json  配置示例
└─ requirements.txt     Python 依赖
```

每个目录和文件的作用、哪些能删，见 [docs/04-项目目录注释.md](docs/04-项目目录注释.md)。

## 数据与隐私

- 仓库里只有程序代码、文档、界面图片和字体，**不包含**任何声音素材、训练数据、模型权重或合成音频
- 训练数据、模型权重、合成结果、日志都在本机 `data/`、`outputs/`、`logs/` 和 GPT-SoVITS 目录下，不会上传
- 服务只监听 `127.0.0.1`，没有账号、遥测或云端请求
- 换电脑时想保留音色，请自行备份 `data/` 和 GPT-SoVITS 的权重目录
- 清理本机缓存：界面右上角齿轮 → 设置 → 清理空间

## 已知限制

- 启动器和文件夹选择框只支持 Windows
- 默认按固定目录关系查找 GPT-SoVITS / ffmpeg / HuggingFace 缓存；不符合时需要用环境变量指定
- 语气判断是关键词规则，不是语义模型，判错时可以在界面上手动选
- 内置翻译模型只做中文 → 日文；其它方向需要本地 Ollama + Qwen3
- 评测分数是声纹相似度，只衡量「像不像」，不评价自然度或好听程度
- 没有自动更新，也没有安装包；升级需要自己拉取代码并重新编译启动器（可选）

## 常见问题

见 [docs/troubleshooting.md](docs/troubleshooting.md)，包含显存不足、引擎起不来、ffmpeg / TorchCodec 报错、路径问题、训练续训、参考音频、翻译和评测等。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/install.md](docs/install.md) | 安装、路径配置、启动、环境变量 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 常见问题与排查 |
| [docs/01-界面设计.md](docs/01-界面设计.md) | 界面布局、配色、字体、动效 |
| [docs/02-模型与依赖清单.md](docs/02-模型与依赖清单.md) | 需要哪些模型、从哪来、多大、许可 |
| [docs/03-开源发布说明.md](docs/03-开源发布说明.md) | 版本更新、升级注意、发布流程 |
| [docs/04-项目目录注释.md](docs/04-项目目录注释.md) | 每个目录/文件的作用 |
| [docs/testing.md](docs/testing.md) | 自检和界面冒烟测试 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方组件与许可 |
| [NOTICE.md](NOTICE.md) | 来源标记与版权 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 提交问题和 PR 的约定 |

## 开发与测试

```bat
python src\backend\selftest.py     :: 需要后端和引擎已启动
node tools\ui_smoke.js             :: 需要后端已启动
```

前端是纯 HTML/CSS/JS，没有构建步骤，改完刷新浏览器即可。

## 许可证与声明

代码使用 [MIT License](LICENSE)。界面素材为本地 AI 生成的原创插画，展示字体为 OFL 许可的站酷庆科黄油体。
项目不附带 GPT-SoVITS、FunASR、声纹模型、翻译模型或任何声音数据，使用这些组件时请遵守各自的许可。
第三方清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**使用前请确认你拥有所使用声音的权利。** 不要克隆他人声音，不要用于冒充、诈骗、造谣或绕过身份验证。
生成的音频在必要场景下请标注为 AI 合成内容。使用者对使用后果负责。