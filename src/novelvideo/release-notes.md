---
version: 2.0.6
attention: low
---
# v2.0.6

## User-facing Highlights (zh)

- **视频延长**: 支持在已配置相应模型时延长画布中的视频，并保留原视频画幅。
- **视频画质与帧率增强**: 可通过已配置的模型调整视频分辨率和帧率，并选择智能插帧等处理方式。
- **音视频分离输出 MP3**: 提取的音频改为 MP3 格式，便于用作支持该格式的模型参考音频。

## User-facing Highlights (en)

- **Video extension**: Extend a canvas video when a compatible model is configured, while preserving its aspect ratio.
- **Video quality and frame-rate enhancement**: Use configured models to adjust resolution and frame rate, including frame interpolation.
- **MP3 output from audio separation**: Extracted audio is now MP3, making it usable as reference audio for models that accept this format.

## Fixes

- 音视频分离现在实际转码为 MP3，并继续兼容已有的 M4A 结果 (#631)。

## Improvements

- 新增可配置的视频延长模式及对应画布入口 (#662)。
- 新增模型驱动的视频增强流程，并完善任务恢复时的节点状态同步 (#716)。
