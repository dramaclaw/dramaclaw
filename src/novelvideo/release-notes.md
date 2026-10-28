---
version: 2.1.0
attention: medium
---
# v2.1.0

## User-facing Highlights (zh)

- **虾导与创作工作流**: 完善技能驱动的创作方案、模型参数确认、画布执行及任务恢复，支持配置第三方 Agent 模型。
- **更多画布工具**: 新增视频逐帧拉片、智能续写、画面裁切、深度动作捕捉入口及本地图片像素尺寸调整；模型能力决定可用的视频模式。
- **媒体存储提前校验**: CE 在付费媒体生成前检查自配存储，提前提示不可用配置，减少因存储问题导致的无效生成。
- **文生视频无需真人素材审核**: 自动关闭并隐藏真人素材审核开关，避免旧配置或误操作触发不必要的审核请求。
- **Codex 0.164.0**: 正式 Docker 构建升级到凭据保护版 Codex 0.164.0，提供 AMD64 与 ARM64 原生镜像。

## User-facing Highlights (en)

- **Agent-assisted workflows**: Improved skill-driven planning, model parameter confirmation, canvas execution and task recovery, with configurable third-party Agent models.
- **More canvas tools**: Added frame-by-frame video analysis, continuation, cropping, depth motion capture entry points and local image pixel resizing. Available video modes follow model capabilities.
- **Media storage preflight**: CE checks self-configured storage before paid media generation and reports unavailable configurations earlier.
- **No real-person material review for text-to-video**: The review switch is hidden and disabled, preventing stale settings or accidental activation from requesting unnecessary review.
- **Codex 0.164.0**: Official Docker builds use the credential-safe Codex 0.164.0 runtime with native AMD64 and ARM64 images.

## Fixes

- 修复 CE 媒体存储校验和错误提示，兼容 Cloudinary 对测试图片的重新编码，并完善中英文界面提示 (#868)。
- 文生视频在界面、任务执行和最终请求层关闭真人素材审核；带参考素材的其他模式保留审核能力 (#877)。
- 改善工作流规划、模型确认、执行状态与音频交付的一致性 (#794、#825、#827、#833、#844、#847)。
- 修复视频处理请求的自动画幅传递，并将 Ladybug JSON 扩展随包提供，避免运行时下载依赖 (#855、#860)。

## Improvements

- 增加渠道模型列表获取与可搜索模型选择，以及第三方 Agent 模型配置 (#795、#826)。
- 增加视频处理入口、按模型能力约束视频模式，以及本地图片像素尺寸调整 (#801、#802、#842)。
- 新增欧洲葡萄牙语本地化，并完善多语言体验 (#866)。
- 升级正式 Docker 构建的 Codex 运行时到 0.164.0，固定镜像摘要并校验提交、架构、版本和二进制 SHA256。
