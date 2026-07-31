---
version: 1.2.0
attention: medium
---
# v1.2.0

## User-facing Highlights (zh)

- **功能积分更透明**: 统一展示功能价格、预计扣费、账户余额和使用记录,批量创作及图片、视频、音频等任务的扣费状态更清晰。
- **虾画创作能力升级**: 完善图片参考、视频参考、音频连接和 Seedance 模型模式切换,并修复 NewAPI 图片尺寸、水印、参考图和视频结果兼容问题。
- **剧本导入更准确**: 导入前可预览原文、章节和场景识别结果,新增对常见中英文场景标题、括号标题和精品短剧格式的支持。
- **任务执行更稳定**: 构建类任务统一接入任务中心,修复结束任务持续加载、知识图谱日志阻塞队列及多个规划和模型调用超时问题。
- **外部智能体可连接 CE**: Claude Code 等本地智能体可通过 MCP 直接调用 DramaClaw CE 的项目和创作能力,无需额外配置访问令牌。

## User-facing Highlights (en)

- **More transparent feature credits**: See feature prices, estimated charges, account balances, and usage history consistently across batch creation, image, video, and audio workflows.
- **Upgraded canvas creation workflows**: Improved image, video, and audio references, automatic Seedance mode selection, and compatibility for NewAPI image sizing, watermarks, references, and normalized video results.
- **More accurate screenplay imports**: Preview source text, chapters, and detected scenes before import, with broader support for common Chinese and English scene headings, bracketed headings, and premium short-drama formats.
- **More reliable task execution**: Build operations now report through the task center, while completed-task loading, queue-blocking graph logs, planning failures, and model timeouts are handled more reliably.
- **External agents can connect to CE**: Local agents such as Claude Code can use MCP to operate DramaClaw CE projects and creation workflows without configuring an additional access token.

## New Features

- 新增统一功能积分价格、预估扣费、余额与使用记录展示 (#210).
- 虾画底部工具栏新增移动和抓手工具,支持快捷键 V/H (#202).
- CE 提供无需额外令牌的 MCP 接入,支持外部智能体操作项目与创作流程 (#190).
- 小说导入页新增原文、章节和场景识别预览 (#220).
- 支持更多常见中英文剧本场景标题格式 (#227).

## Bug Fixes

- 修复 Seedance 1.x 单图模式被错误禁用,并在接入视频或音频时自动切换到 Seedance 2.0 全能参考 (#203).
- 修复音频节点连接范围和音视频分离后背景音节点孤立的问题 (#204).
- 修复视频参考生成脚本未读取视频内容,以及角色图和参考列为空的问题 (#209).
- 修复知识图谱日志阻塞 Celery 心跳和规划任务超时的问题 (#206, #215).
- 修复括号场景标题及精品短剧场景标题识别问题 (#213, #214).
- 完善剧本格式错误说明和上传限制校验,避免无效或超限内容进入导入流程 (#229).
- 修复虾驿标准化视频任务结果无法读取的问题 (#217).
- 修复构建类任务和已结束任务仍持续显示加载状态的问题 (#219, #222).
- 修复 NewAPI 图片生成与编辑中的参考图、默认水印和分辨率参数问题 (#221).

## Improvements

- 降低积分汇总接口的重复请求压力 (#223).
- 统一界面视觉规范和设计变量,提升页面样式一致性 (#212).
