# 参与贡献

欢迎提 issue 和 PR。这个项目是个人维护的本地工具，自己用着舒服来的记录一下。

## 提 Issue

- 先看 [docs/troubleshooting.md](docs/troubleshooting.md) 和 [docs/install.md](docs/install.md)
- 使用 issue 模板（Bug 报告 / 功能建议）
- Bug 请附：系统版本、显卡和显存、Python 版本、GPT-SoVITS 版本、复现步骤、相关日志（`logs/` 下）
- 涉及界面问题的，附截图或录屏
- 不要上传个人音频、模型权重、包含个人路径的完整日志

## 开发环境

1. 按 [docs/install.md](docs/install.md) 准备好 GPT-SoVITS、ffmpeg 和 Python 环境
2. 启动引擎（9880）和后端（8017）
3. 前端是纯静态文件，改完刷新浏览器即可，没有构建步骤
4. 修改 Python 代码后重启后端

目录说明见 [docs/04-项目目录注释.md](docs/04-项目目录注释.md)。

## 改代码时

- 后端：Python 3.10+，保持现有接口返回结构；错误信息用中文，尽量能指导用户下一步
- 前端：`src/static/` 下三个文件，不引入构建工具和 CDN；素材和字体保持本地
- 启动器：C# / .NET Framework 4.x，用 `launcher/build.bat` 编译
- 注释写清楚「为什么这么做」，不要写开发过程、任务编号或临时记录
- 不要提交：`data/` 下的素材和数据、`outputs/`、`logs/`、模型权重、`exe`、任何密钥
- 不要改动无关格式，保持 diff 便于 review

## 测试

提交前至少跑：

```bat
python -m py_compile src\backend\app.py
node --check src\static\app.js
```

改了后端或前端流程的，启动服务后跑 `src\backend\selftest.py` 和 `tools\ui_smoke.js`。
详见 [docs/testing.md](docs/testing.md)。

## 提交 PR

- 一个 PR 解决一个问题，说明改了什么、为什么、怎么验证
- 涉及界面的附截图
- 新增依赖前先讨论，尽量复用 GPT-SoVITS venv 里已有的包
- 提交信息用中文或英文都可以，写清楚目的

## 许可

提交的代码默认按项目的 MIT 许可发布。引用第三方代码时请确认许可兼容，并在 PR 里说明来源。
