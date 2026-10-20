# 常见问题与排查

按现象查找。命令示例默认在项目根目录执行，Python 用 GPT-SoVITS 的 venv。

## 显存不足（CUDA out of memory）

**现象**：合成或训练报 `CUDA out of memory` / `OutOfMemoryError`，后端会把引擎的报错翻译成中文返回。

**处理**：

- 关掉占显存的程序：游戏、浏览器硬件加速、其它推理服务
- 训练页把音色批量降到 1，韵律批量降到 2，轮数先试 4 / 4
- 合成和训练不要同时进行
- 停止训练会结束训练进程树；显存要等引擎进程退出后重开才真正释放

8GB 显存是实际下限。更小的显存可以尝试降低批量，但速度会很慢。

## 引擎起不来

**现象**：界面能打开，但合成提示「声音引擎还没就绪」，或启动器卡在启动引擎。

**检查**：

```bat
:: 引擎文档页能打开 = 引擎已就绪
start http://127.0.0.1:9880/docs

:: 后端健康检查里 engine_up 应为 true
start http://127.0.0.1:8017/api/health
```

**常见原因**：

- 引擎首次加载模型需要 1~3 分钟，启动器最多等 240 秒
- 显存被占用，引擎启动失败
- 缺少依赖，或 TorchCodec 补丁没有打（见下一节）
- 端口被占用，见「端口占用」

日志：`logs/engine.log`、`logs/engine.err`、`logs/launcher.log`。

## ffmpeg 找不到 / TorchCodec 报错

**现象 A**：导入素材提示找不到 ffmpeg，或转码失败。

处理：确认 `ffmpeg.exe` 存在，设置 `ABV_FFMPEG_DIR` 指向它所在的 `bin` 目录，重启后端。

**现象 B**：合成时报 `Could not load libtorchcodec`。

原因：torchaudio 2.9+ 读取音频需要 TorchCodec，而它依赖 FFmpeg 的共享库 DLL；只有静态版 `ffmpeg.exe` 不够。

处理：给 GPT-SoVITS 打补丁，把 `GPT_SoVITS/TTS_infer_pack/TTS.py` 里的 `torchaudio.load` 换成仓库自带的 `tools.my_utils.load_audio`，并把 ffmpeg 的 `bin` 目录加入 PATH。
升级 GPT-SoVITS 后补丁会被覆盖，需要重新打。

## 训练中断了，能续训吗

可以。特征和 checkpoint 在 GPT-SoVITS 的 `logs/<实验名>/` 下，中断不会丢。

训练页的「从零训练」：

- 勾选（默认）：备份旧 checkpoint，从预训练底模重新训练
- 取消勾选：从最新 checkpoint 续训（环境变量 `ABV_FROM_SCRATCH=0` 同效）

改了标注或新增素材后，建议先重新做一次「识别 + 清洗」再训练。

## 中文路径和空格

训练脚本会写临时配置。Windows 下部分训练组件用系统默认编码读取配置，路径含中文可能乱码。
本项目训练脚本已经用纯 ASCII 转义写临时配置；自己改脚本时请保持这个做法。

项目路径本身带空格（例如 `C:\Users\...\Aki Voice`）时，部分命令行需要加引号：

```bat
"C:\path with space\.venv\Scripts\python.exe" src\backend\app.py
```

## 模型权重和参考音频放哪

- 权重：`.pth` 放 `GPT-SoVITS/SoVITS_weights_v2Pro/`，`.ckpt` 放 `GPT-SoVITS/GPT_weights_v2Pro/`
- SoVITS 文件名里需要有 `_eN_`（轮数），例如 `voice_light_e6_s294.pth`
- 参考音频：`data/ref/*.wav`，时长必须在 3~10 秒
- 训练出的权重大约每轮 129MB（SoVITS）+ 148MB（GPT），注意磁盘

在「声の設定 → 当前音色」里可以切换已扫描到的模型，点「改名」只改显示名，不改文件名。
训练完成会自动启用最高轮数的模型。

## 语气不生效

语气通过切换参考音频实现。先生成语气库：

```bat
<venv>\Scripts\python.exe data\voice\build_tones.py
```

生成结果在 `data/ref/tones/`。素材里没有 3~7.5 秒的片段时，对应语气会退回默认参考音频。
语气判断是关键词规则，判错时可以在合成页手动选。

## 翻译不可用 / 译文混英文

- 输入语言和输出语言相同时不翻译
- 中→日：Ollama（Qwen）优先；没有 Ollama 时用内置 opus-mt 模型（约 300MB，CPU 推理，首次加载 3~8 秒）
- 其它方向需要 Ollama + Qwen3
- 内置模型缓存在 HuggingFace 目录；启动器会给子进程设置 `HF_ENDPOINT=https://hf-mirror.com`
- 翻译结果会显示在结果区，合成前可以手动改

## 评测分数怎么理解

分数是声纹余弦相似度（0~1），衡量「像不像本人」，不评价自然度。

- ≥0.78 很像 / ≥0.65 像 / ≥0.50 一般 / <0.50 不像
- 跨语言分数通常低于本人母语，属正常
- 同一组固定测试句、同一版本之间对比才有意义
- 分数上限由训练数据和参考音频决定

## 启动器双击没反应 / 目录和作者不一样

启动器会按 exe 所在位置推导项目根目录，再找上两级的 `ai` 目录和 `tools/ffmpeg/bin`。
目录不同时设置环境变量：

```bat
set ABV_PROJECT_ROOT=D:\projects\voice-studio
set ABV_AI_ROOT=D:\ai
set ABV_FFMPEG_DIR=D:\tools\ffmpeg\bin
```

或者手动启动引擎和后端，不使用启动器。

启动失败看 `logs/launcher.log`。

## 素材导入为空 / 识别失败

- 支持 ogg / wav / flac / mp3 / m4a / opus / wma
- 确认文件夹里确实有音频，且路径可读
- 识别需要 `funasr` 包和 `ABV_FUNASR_SNAPSHOT` 指向的模型
- 识别很慢时看 CPU/GPU 占用；识别在 GPU 上跑，batch 为 1

## 页面打不开或样式错乱

- 后端是否在运行：<http://127.0.0.1:8017/api/health>
- 强制刷新：`Ctrl + F5`
- 静态文件禁用了缓存，一般不需要清缓存
- 看浏览器控制台是否有报错，记录后提 issue

## 端口占用

```bat
netstat -ano | findstr :9880
netstat -ano | findstr :8017
netstat -ano | findstr :11434
```

结束占用端口的进程，或者调整启动参数。

## 删除/恢复素材和清理空间

- 删除素材会进回收站，素材页「恢复删除」可以找回
- 右上角齿轮 → 设置 → 清理空间，可以清理回收站、训练缓存、合成产物和日志
- 清理后设置面板不会关闭，刷新体积后可以继续操作
