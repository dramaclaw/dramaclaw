---
version: 1.3.2
attention: low
---
# v1.3.2

## User-facing Highlights (zh)

- **本地 ComfyUI 配置更简单**: MiniMax H3 现在以单一模型接入多个 Workflow，由虾驿根据文生视频、首帧或全能参考模式自动选择流程，并支持一键清理本地配置。
- **视频生成模式更准确**: 画布选择的首帧、首尾帧等业务模式会在校验、计费、任务执行和历史恢复中保持一致，不再根据素材数量被静默改写。
- **主线生成默认值优化**: 场景参考图提升为中等质量，主线视频模型列表加入 Seedance 2.0 Mini 并精简不推荐选项，同时将新小说上传上限调整为 512KB。

## User-facing Highlights (en)

- **Simpler local ComfyUI setup**: MiniMax H3 now uses one model entry for multiple workflows, with RelayClaw selecting the appropriate text-to-video, first-frame, or all-reference workflow and an option to clear local configuration in one action.
- **More accurate video generation modes**: Canvas selections such as first-frame and first/last-frame now remain consistent through validation, billing, task execution, and history restoration instead of being silently changed based on reference count.
- **Improved mainline defaults**: Scene reference images now use medium quality, Seedance 2.0 Mini is available while less suitable mainline choices are hidden, and the new novel upload limit is set to 512KB.

## New Features

- 简化本地 ComfyUI 配置，使用单一 MiniMax-H3-local 模型承载多个 Workflow，并支持一键清理配置 (#277).
- 主线视频模型新增 Seedance 2.0 Mini，并保留已有项目和任务对旧模型的执行兼容性 (#267).

## Bug Fixes

- 修复首帧、首尾帧等视频生成模式会因参考图片数量而被错误改写的问题 (#273).

## Improvements

- 将场景参考图质量提升为 medium，并同步实际请求的计费参数；新小说上传限制调整为 512KB (#267).
