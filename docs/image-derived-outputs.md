# 图片节点的 SVG 与 GIF 输出

图片顶部工具栏的「矢量图」「动态图」会创建独立结果节点。节点支持预览、下载、删除及重试；任务引用持久化到画布，刷新后恢复等待。

- SVG：`POST /projects/{project}/freezone/image/vectorize`，请求 `image_url`、`canvas_id`、`node_id`。本地 vtracer 转换，免费。
- GIF：`POST /projects/{project}/freezone/image/animate`，请求同上。先生成首帧锁定、4 秒、720p、无音频视频，再转为循环 GIF。视频按目录规则计费，转码免费。
- 仅重试转换：`POST /projects/{project}/freezone/image/animate-gif`，请求 `video_url`、`canvas_id`、`node_id`。已有视频时不重复生成视频。

路径以 `/api/v1` 为前缀。只接受当前项目媒体。视频任务使用 `video` lane，两个本地转换任务使用项目 home node 的 `ffmpeg` lane。EE 必须同时启动对应消费者；部署镜像必须包含 ffmpeg 和 vtracer（两个仓库的 Dockerfile 已包含安装）。本地开发需要把 vtracer 所在目录加入 worker 的 PATH。

转换支持超时、取消清理、输出大小限制、原子写入以及源路径约束。GIF 限制为 12 fps、480 像素宽、最长 15 秒、最大 30 MiB；SVG 最大 12 MiB，复杂照片可能损失细节。

视频成功但 GIF 子任务投递失败时，视频结果保留，节点可重试本地转换。上游生成失败时显示错误并支持重新生成。
