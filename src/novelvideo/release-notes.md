---
version: 1.3.0
attention: low
---
# v1.3.0

## User-facing Highlights (zh)

- **模型能力统一管理**: CE 新增模型渠道与能力配置,图片和视频模型、参数及素材连线上限统一由后台下发,不再依赖前端内置清单。
- **官方配置内置 MiniMax-H3**: 使用官方配置时可直接选择 MiniMax-H3 视频模型,支持文生视频、首帧、首尾帧、图片参考和全能参考等生成模式。
- **接入本地 ComfyUI**: 自定义与本地加官方混合模式均可连接本地 ComfyUI,配置 API Format Workflow,并让指定视频模型走本地生成而其他模型继续使用 RelayClaw。
- **部署本地 MiniMax H3 视频模型**: 提供 MiniMax H3 文生视频、图生视频和参考生视频 Workflow 初始模板,可按本机 ComfyUI 节点与模型文件调整后接入画布。
- **视频素材与计费更准确**: 修正视频生成模式语义和参考素材限制,补齐参考音频总时长校验,支持按视频输入量计费,并让主线与画布应用各自正确的促销报价。
- **画布与任务体验升级**: 大型画布平移采用轻量 LOD,视频节点面板完成拆分,同时修复小地图拖动、任务进度卡住、等待超时和主动终止提示。
- **自托管数据更可靠**: Docker 部署持久化生成媒体并中转远程资产,备份同步前先快照可变状态,降低重启、外链失效或同步竞争造成的数据风险。
- **生成结果更稳定**: 优化结构化输出、视频 Beat、角色身份和官方风格提示,单行脚本失败时继续处理其余内容,并补充旁白与参考音频前置校验。

## User-facing Highlights (en)

- **Unified model capability management**: CE now manages model channels and capabilities, with image/video models, parameters, and reference limits delivered by the backend instead of a hard-coded frontend catalog.
- **MiniMax-H3 built into the official profile**: MiniMax-H3 is directly selectable with the official configuration, supporting text-to-video, first-frame, first/last-frame, image-reference, and all-reference generation modes.
- **Connect local ComfyUI**: Custom and Local + Official Hybrid modes can connect to a local ComfyUI service, configure API Format workflows, and route selected video models locally while other models continue through RelayClaw.
- **Deploy a local MiniMax H3 video model**: Starter workflows are provided for MiniMax H3 text-to-video, image-to-video, and reference-to-video, ready to adapt to locally installed ComfyUI nodes and model files.
- **More accurate video references and billing**: Video generation modes and reference limits are corrected, total reference-audio duration is validated, pricing can account for video input, and promotional quotes use the correct mainline or canvas context.
- **Upgraded canvas and task experience**: Large canvases use lightweight LOD while panning, the video node panel is split out, and minimap dragging, stuck progress, timeout, and cancellation feedback are fixed.
- **More reliable self-hosted data**: Docker deployments persist generated media and relay remote assets, while backup sync snapshots mutable state first to reduce restart, expired-link, and synchronization risks.
- **More stable generation results**: Structured output, video beat, character identity, and official style prompts are refined; isolated script-line failures no longer abort the rest, with stronger narrator and reference-audio validation.

## New Features

- CE 新增模型渠道与能力管理,并由后台统一下发图片/视频模型配置、参数和素材上限 (#251, #254).
- 官方配置内置 MiniMax-H3 视频模型及常用生成模式,无需额外创建媒体模型配置 (#254).
- 自定义与本地加官方混合模式支持接入本地 ComfyUI,并提供 MiniMax H3 文生视频、图生视频和参考生视频 Workflow 初始模板 (#254).
- 支持依据视频输入量计算生成费用,并补充产品功能可见性与计费上下文 (#249, #258).

## Bug Fixes

- 修复 EE 下全能参考被错误拦截及节点进度停在 96% 的问题 (#245).
- 修复前端任务等待预算与后端上限不一致导致的过早超时 (#242).
- 修复主动终止任务成功后仍显示错误提示的问题 (#243).
- 修复换图后图片节点继续显示旧失败横幅的问题 (#224).
- 修复结构化输出启用推理模式导致的兼容性问题 (#248).
- 单行模型输出失败时继续处理其余脚本内容,避免整批任务中断 (#244).
- 修正视频生成模式语义、素材模式和素材连线上限 (#253, #255).
- 修复参考音频总时长与旁白音色前置条件缺少校验的问题 (#260, #262).
- 修复小地图拖动增益随视口偏移持续放大的问题 (#259).
- 修复备份同步期间可变状态不一致的问题 (#261).
- 修正视频 Beat、国漫角色身份及官方风格提示的内容污染问题 (#263, #264, #265).
- 修复主线与画布生成报价缺少产品入口上下文,导致促销价格应用不准确的问题 (#266).

## Improvements

- 为大型画布增加平移 LOD 外壳,并拆分视频节点操作面板以降低渲染开销 (#241).
- Docker 部署持久化生成媒体,并支持中转保存 Cloudinary 等远程资产 (#247).
- 按实际交付结果结算积分并发送带类型的计费数量,提高计费记录准确性 (#239, #240).
