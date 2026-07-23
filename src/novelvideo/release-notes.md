---
version: 1.1.4
attention: low
---
# v1.1.4

## User-facing Highlights (zh)

- **知识图谱可视化**: 小说导入完成后可直接查看知识图谱,支持缩放、拖动、展开节点并检查关系和属性。
- **图片与视频构图更准确**: Seedance 首帧、Beat 渲染和视频裁剪会遵循实际素材或所选输出比例,蒙版编辑也能更准确识别指定区域。
- **知识图谱构建更稳定**: 项目会固定使用对应的嵌入模型与网关,并限制并发请求,减少配置变化、并行任务和上游限流造成的失败。
- **操作前置校验更清楚**: 未导入小说时规划角色、场景或剧集会直接提示先导入内容,不会创建无效任务或产生扣费。

## User-facing Highlights (en)

- **Knowledge graph visualization**: Explore the imported novel's knowledge graph with pan, zoom, node expansion, relationships, and property details.
- **More accurate image and video framing**: Seedance first frames, Beat renders, and video crops now follow the actual source or selected output ratio, while mask edits identify the intended region more reliably.
- **More reliable knowledge graph builds**: Projects retain their assigned embedding model and gateway, with bounded concurrency to reduce failures from configuration changes, parallel work, and upstream rate limits.
- **Clearer prerequisite checks**: Character, scene, and episode planning now asks for an imported novel before creating a task or reserving credits.

## New Features

- 新增导入小说知识图谱的交互式可视化,支持查看节点、关系和属性 (#161).

## Bug Fixes

- 未导入小说时阻止角色、场景和剧集规划,避免无效任务及扣费 (#162).
- 修复 Seedance 首帧方向、Beat 渲染比例和视频输入裁剪与目标比例不一致的问题 (#166, #167, #168).
- 修复不同项目的知识图谱嵌入模型和网关配置相互影响的问题 (#170).
- 修复蒙版编辑区域仅存在于透明通道、视觉模型无法准确定位的问题 (#174).

## Improvements

- 限制单次知识图谱流水线的模型与嵌入并发请求,降低上游限流导致的导入失败 (#171).
