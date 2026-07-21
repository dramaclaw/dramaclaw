---
version: 1.1.3
attention: low
---
# v1.1.3

## User-facing Highlights (zh)

- **Piko 一下小游戏库**: 新增记忆翻牌、打砖块、滚动小球、飞行的 Piko、Piko 接物和 Piko 跃迁,支持键盘与鼠标操作、音效、计分和重新挑战。
- **自定义风格预览可持久保存**: 用户上传的风格参考图会随项目保存,刷新后仍可在风格列表和详情中查看。
- **生成失败提示更清楚**: 图片和视频生成失败时优先展示简洁的上游错误原因,同时保留完整诊断信息供复制排查。

## User-facing Highlights (en)

- **Piko mini game library**: Adds memory match, breakout, rolling ball, Flying Piko, Piko catch, and Piko leap with keyboard and pointer controls, sound, scoring, and replay.
- **Persistent custom style previews**: User-uploaded style references are saved with the project and remain visible in style lists and details after refresh.
- **Clearer generation failures**: Image and video failures now show concise provider messages while preserving complete diagnostics for troubleshooting.

## New Features

- 扩展「Piko 一下」为可滚动的小游戏库,新增六款轻量小游戏及统一音效控制 (#155, #156).

## Bug Fixes

- 修复自定义风格参考图刷新后丢失、预览地址错误及异常响应仍继续分析的问题 (#153, Fixes #152).
- 优化图片和视频生成失败提示,保留完整错误与请求 ID 供复制排查 (#154).
- 修复任务中心「图片反推提示词」显示为内部英文任务名的问题 (#146).

## Improvements

- 按运营计划下线猎魈人推广入口与相关展示,保留独立的社区作品内容 (#145).
