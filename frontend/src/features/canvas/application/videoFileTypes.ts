// 画布文件识别口径的单一来源(视频容器 + 可收素材类型)。
//
// 浏览器给 .mxf 等专业/老容器的 file.type 是空串，纯 `startsWith("video/")`
// 会把它们挡在上传门外。这里统一成「MIME 是 video/* 或扩展名在白名单里」，
// 让画布拖放（Canvas）、UploadNode morph、VideoNode 各入口口径一致；命中后
// 交给 videoTranscode.ts 的 ffmpeg 兜底把这些容器转成 H.264 mp4。

// 无（或不可靠）MIME、但 ffmpeg.wasm 能解封装的容器扩展名。
export const EXTRA_VIDEO_EXTENSIONS = /\.(mxf|mkv|avi|ts|mts|m2ts|flv|wmv|m4v|mpg|mpeg)$/i;

// <input accept> 用：video/* 覆盖有 MIME 的，逗号后逐个列出无 MIME 的扩展名。
export const VIDEO_FILE_ACCEPT =
  "video/*,.mxf,.mkv,.avi,.ts,.mts,.m2ts,.flv,.wmv,.m4v,.mpg,.mpeg";

export function isVideoFile(file: { type: string; name: string }): boolean {
  return file.type.startsWith("video/") || EXTRA_VIDEO_EXTENSIONS.test(file.name);
}

// 画布各入口「这个文件能不能当素材收下」的统一口径，与 UploadNode 的媒体分流
// 一致（图片 / 视频 / 音频）。非媒体文件会被 UploadNode 静默忽略，所以必须在建
// 节点之前就挡掉，否则会留下一个连着线却永远空着的 upload 节点。
export function isSupportedMediaFile(file: { type: string; name: string }): boolean {
  return (
    file.type.startsWith("image/") ||
    // isVideoFile 兜住 .mxf 等 file.type 为空串的专业容器。
    isVideoFile(file) ||
    file.type.startsWith("audio/")
  );
}
