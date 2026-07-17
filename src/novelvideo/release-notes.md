---
version: 1.1.2
attention: low
---
# v1.1.2

## User-facing Highlights (zh)

- **虾格视频支持 HappyHorse 1.0**: 画布视频节点新增文生视频、首帧、图片参考和视频编辑四种 HappyHorse 模式,按上游节点自动切换。
- **虾料导入更稳**: 上传小说时防误切走,导入中刷新或返回页面会自动恢复进度视图。
- **自建模型链路统一**: CE 的 NewAPI 运行时与 Freezone 视觉路由统一,本地/自建网关的视频与视觉能力更一致。

## User-facing Highlights (en)

- **HappyHorse 1.0 in Freezone video nodes**: Canvas video nodes now support HappyHorse text-to-video, first-frame, image-reference, and video-edit modes with automatic mode selection from upstream nodes.
- **More reliable novel ingest**: Novel upload is protected from accidental navigation, and in-progress imports restore their progress view after refresh or returning to the page.
- **Unified self-hosted model routing**: CE NewAPI runtime and Freezone vision routing are now aligned for more consistent video and vision behavior with local/self-hosted gateways.

## New Features

- 新增 HappyHorse 1.0 视频四模式:文生视频、首帧、图片参考、视频编辑 (#141).

## Improvements

- 统一 CE NewAPI runtime 与 Freezone vision routing,并升级 bundled new-api image 到 `v1.0.0-rc.21` (#138, #140).

## Bug Fixes

- 修复虾料导入中切走、刷新后页面丢失进度视图的问题,并修复 stale-cache 与跨项目复用下的恢复漏洞 (#139, #142).
- 统一关键帧提示词路由,移除无效的样式提取路径 (#143).
