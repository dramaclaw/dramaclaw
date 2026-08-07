---
version: 1.3.1
attention: low
---
# v1.3.1

## User-facing Highlights (zh)

- **官方媒体模型目录可更新**: CE 设置页现在可手动检查官方媒体模型目录更新，也可开启进入设置页时自动检查；新目录生效后，虾画图片和视频模型选项会立即刷新。
- **视频能力与素材限制更准确**: 图生视频能力可独立配置，参考音频和视频支持单条及合计时长限制；前后端会在计费和任务投递前拦截不符合要求的素材。
- **画布创建与模型选择更顺畅**: 低缩放下通过快捷栏、技能入口或拖线菜单创建节点时会自动聚焦，同时模型选择器会依据媒体目录准确判断视频素材是否可用。

## User-facing Highlights (en)

- **Updatable official media catalog**: CE settings can now check for official media model catalog updates manually or automatically when the settings panel opens; image and video model options refresh immediately after an update.
- **More accurate video capabilities and reference limits**: Image-to-video can be configured independently, with per-item and total duration limits for reference audio and video; invalid media is rejected before billing or task dispatch.
- **Smoother canvas creation and model selection**: Nodes created from quick-add, skill, or connection menus are focused automatically at low zoom, while the model picker now uses the media catalog to determine video-reference compatibility.

## New Features

- CE 支持查看并更新官方媒体模型目录，并可选择在打开设置页时自动检查更新 (#271).
- 视频模型支持独立声明图生视频能力，并配置参考音频、参考视频的单条及合计时长限制 (#268).

## Bug Fixes

- 修复模型选择器未按媒体目录判断视频素材能力，导致可选模型进入无可用模式状态的问题 (#269).
- 修复低缩放下通过快捷栏、技能入口或拖线菜单创建节点后，新节点不在可见区域的问题 (#270).
