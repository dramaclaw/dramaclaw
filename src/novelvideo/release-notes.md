---
version: 2.0.0
attention: medium
---
# v2.0.0

## User-facing Highlights (zh)

- **全新结构化创作流程**: 新项目默认从原文直接构建分集、角色和场景，不再依赖知识图谱或向量化处理，导入与规划更快、更稳定；已有项目继续兼容原流程。
- **组织与渠道协作升级**: 增加组织品牌、模型可见范围、项目授权和任务并发控制能力，让多组织、多渠道环境下的权限、额度和任务归属更加清晰。
- **虾画与资产库全面增强**: 画布支持标签页、元素大纲、文本生成、图生图风格墙和 HappyHorse 1.1，资产库支持按用途和文件夹管理，常用创作操作更集中。
- **模型渠道配置更灵活**: 官方媒体目录支持独立更新，自定义模型配置可同步，并可按渠道能力管理文本、图片、视频和音频模型，媒体请求协议与诊断信息也更加一致。
- **任务执行与大画布更可靠**: 完善项目级存储隔离、队列限流、授权重试、计费结算和失败回收，同时通过缩略图与按需加载降低大型画布和资产库的等待与卡顿。

## User-facing Highlights (en)

- **New structured creation workflow**: New projects now build episodes, characters, and scenes directly from source text without requiring knowledge-graph or embedding processing, improving import speed and reliability while keeping existing projects compatible with the legacy flow.
- **Stronger organization and channel collaboration**: Organization branding, model visibility, project grants, and task concurrency controls make permissions, quotas, and task ownership clearer in multi-organization and multi-channel deployments.
- **Major Canvas and asset library upgrades**: Canvas now includes tabs, an element outline, AI text generation, an image style wall, and HappyHorse 1.1 support, while the asset library organizes media by purpose and folder.
- **More flexible model channel configuration**: The official media catalog can update independently, custom model settings stay synchronized, and channels can be managed by text, image, video, and audio capabilities with more consistent media request diagnostics.
- **More reliable execution at scale**: Project-scoped storage, queue limits, authorization retries, credit settlement, and failure recovery are hardened, while thumbnail and on-demand loading reduce stalls on large canvases and asset libraries.

## New Features

- 新增结构化导入与双轨知识流水线，新项目默认使用结构化流程直接生成分集、角色和场景，同时兼容已有项目 (#352, #353, #354, #355, #367).
- 增加组织品牌、组织模型可见范围和项目授权状态等多组织协作能力 (#274, #320, #345, #385, #389).
- 支持官方媒体目录更新、自定义模型配置同步和按渠道能力管理模型 (#278, #308, #321).
- 虾画新增标签页、元素大纲、文本生成、图生图风格墙与 HappyHorse 1.1，资产库增加用途分类和文件夹管理 (#276, #279, #288, #297, #318, #325).
- 登录页增加可远程更新的公告入口 (#366, #379, #383).

## Bug Fixes

- 修复结构化项目中的章节映射、角色结果完整性、场景依赖、环境契约和解说配置等稳定性问题 (#351, #356, #359, #360, #362, #363, #364, #375).
- 修复项目目录隔离、任务授权重试、队列限流、计费结算及 CE/EE 配置边界问题 (#309, #319, #324, #326, #327, #336, #339, #341).
- 修复视频节点素材变化后模式未正确回退、视频编辑入口错误禁用及音频声线无效请求入队的问题 (#282, #338, #392).

## Improvements

- 统一媒体模型请求协议并补全模型调用诊断，减少渠道参数不一致导致的生成失败 (#292, #317).
- 画布和资产库改用缩略图、聚合查询、视口附近加载和按需读取，降低大项目中的重复请求与媒体解码开销 (#329, #350, #380, #384, #386, #390).
- 慢网络上传不再受固定 30 秒超时限制，并完善历史图片缩略图生成与缓存隔离 (#307, #344, #371, #376).
