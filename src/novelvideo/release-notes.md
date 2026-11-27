---
version: 2.2.0
attention: high
---
# v2.2.0

## User-facing Highlights (zh)

- **画布和虾导**：画布操作支持服务端执行，刷新后更容易恢复对话和任务状态；互动广告的图片提示词会跟随界面语言。
- **模型与声音**：模型选择器可展示简介和标签；音色设计支持中文输入，音频克隆通过媒体中转发送参考录音。使用克隆功能前请配置可提供公网 HTTPS 地址的媒体中转。
- **视频创作**：新增视频增强、处理记录和画布入口；主线视频模型不再提供 Seedance 1.x。
- **本地部署与集成**：支持兼容 S3 的媒体中转，以及带凭据的远程 MCP 入口。发行镜像沿用 main 的 Codex 0.162.0，不安装 Hermes。

## User-facing Highlights (en)

- **Canvas and Agent**: Canvas commands can run on the server. Conversation and task recovery after refresh have improved, and interactive ad image prompts follow the interface language.
- **Models and voices**: Model pickers support descriptions and tags. Voice design handles Chinese IME input, and voice cloning sends reference recordings through a media relay. Configure a publicly reachable HTTPS relay before cloning.
- **Video creation**: Video enhancement is available from the canvas with processing history. Seedance 1.x is no longer offered in the mainline video workflow.
- **Self-hosting and integrations**: Use S3-compatible media relays and a credentialed remote MCP endpoint. Release images use the Codex 0.162.0 runtime pinned on main and do not install Hermes.
