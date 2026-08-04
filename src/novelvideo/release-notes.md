---
version: 1.2.1
attention: low
---
# v1.2.1

## User-facing Highlights (zh)

- **媒体生成参数更可靠**: 视频比例、分辨率和模型专用参数会完整传递,并修正 2K、4K 等尺寸换算及积分不足提示。
- **小说导入进度更清晰**: 构建知识图谱时持续展示当前阶段、完成比例和已用时间,长时间导入不再像卡住一样。
- **旧项目规划兼容性提升**: 无标准场景标题的历史剧本也可重新规划场景,Beat 生成与资产规划统一使用当前制作正文。
- **任务与积分界面更稳定**: 修复草图编辑进度回退,积分中心改为更清晰的中性配色并让记录表格独立滚动。

## User-facing Highlights (en)

- **More reliable media parameters**: Video ratios, resolutions, and model-specific options are preserved, with corrected 2K/4K sizing and clearer insufficient-credit errors.
- **Clearer novel import progress**: Knowledge-graph imports now show live stages, percentage, and elapsed time so long-running work no longer appears stalled.
- **Better compatibility for existing projects**: Legacy scripts without standard scene headings can be planned again, while Beat generation and asset planning use the same production text.
- **More stable task and credit screens**: Sketch-edit progress no longer jumps backward, and the credit center gains clearer neutral styling with an independently scrolling history table.

## Bug Fixes

- 修复 NewAPI 视频请求丢失比例、分辨率和模型专用参数的问题,并修正 2K、4K 尺寸换算及积分不足提示 (#235).
- 修复知识图谱导入期间普通日志导致进度归零的问题,新增实时阶段和计时展示 (#232).
- 修复历史剧本缺少标准场景标题时无法重新规划场景的问题 (#230).
- 统一 Beat 生成与资产规划的制作正文来源,避免跳过改编稿 (#231).
- 修复草图编辑任务在输出日志时进度条回退到零的问题 (#233).

## Improvements

- 移除 Beat 脚本流程中未使用的旧图谱工具和重复状态加载,保持现有生成行为不变 (#234).
- 优化积分中心配色、筛选控件及长列表滚动体验 (#237).
- 虾导入口暂时显示升级提示,避免用户进入尚未完成的功能 (#216).
