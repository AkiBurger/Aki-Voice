# 第三方组件与许可

本项目只提供调用代码，不重新分发下列模型、数据和程序。使用前请阅读各上游项目的许可，以它们仓库里的 LICENSE 为准。

## 随仓库分发

| 内容 | 许可 | 位置 |
|---|---|---|
| 本项目代码 | MIT，见 [LICENSE](LICENSE) | 全部源码 |
| 站酷庆科黄油体（ZCOOL QingKe HuangYou） | SIL Open Font License 1.1，见 [src/static/fonts/OFL-ZCOOL.txt](src/static/fonts/OFL-ZCOOL.txt) | `src/static/fonts/`、启动器内嵌子集 |
| 界面插画 | Hamburger本地 AI 生成，无版权角色；随项目以 MIT 分发 | `src/static/assets/`、`launcher/assets/` |

## 需要用户自行准备的第三方组件

| 组件 | 用途 | 许可 / 来源 |
|---|---|---|
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) v2Pro | 声音合成与训练引擎 | 代码为 MIT；预训练模型与音色数据的许可以项目页面为准 |
| [FunASR](https://github.com/modelscope/FunASR) / Fun-ASR-Nano | 语音识别 | FunASR 代码为 MIT；模型许可以 ModelScope 页面为准 |
| [ERes2NetV2 / 3D-Speaker](https://github.com/modelscope/3D-Speaker) | 声纹相似度评测 | 以 3D-Speaker 仓库许可为准 |
| [MarianMT / opus-mt-zh-ja](https://huggingface.co/Helsinki-NLP/opus-mt-zh-ja) | 内置中→日翻译 | 模型许可以 HuggingFace 模型页为准 |
| [transformers](https://github.com/huggingface/transformers) | 加载翻译模型 | Apache-2.0 |
| [pysbd](https://github.com/nipunsadvilkar/pySBD) | 英文分句（缺失时回退正则） | MIT |
| [FFmpeg](https://ffmpeg.org/) | 音频转码与读取 | 取决于构建版本（LGPL 或 GPL） |

| [Ollama](https://ollama.com/) / Qwen3 | 可选的本地翻译 | Ollama 为 MIT；Qwen3 模型许可以其发布页为准 |

## 不随仓库分发的内容

- 任何声音素材、训练音频、参考音频
- 任何训练数据、标注文件、评测数据
- SoVITS `.pth`、GPT `.ckpt` 等模型权重
- GPT-SoVITS 预训练模型、Fun-ASR 模型、翻译模型缓存
- 启动器程序 `AkiBurgerVoice.exe`

## 声音克隆的合规提醒

克隆声音可能涉及声音权、人格权、著作权和平台规则。请确认：

1. 你拥有所使用声音的权利，或已获得明确授权
2. 不用于冒充他人、诈骗、造谣、绕过身份验证等违法或侵权用途
3. 生成的音频在必要场景下明确标注为 AI 合成内容
4. 你所在地区关于 AI 生成内容和声音克隆的法律要求

作者不对使用者的行为或后果负责。
