/**
 * 上传前的视频编码归一化（纯前端，不占服务端资源）。
 *
 * 背景：飞书录屏 / iPhone 拍摄等来源默认是 HEVC (H.265)。Windows Edge 没装
 * 「HEVC 视频扩展」时解不了码——画布上表现为节点黑屏、只有时长和声音
 * （Chrome 107+ 自带硬件 HEVC 解码所以看不出问题）。Web 端唯一稳妥的组合是
 * H.264 (avc) + AAC，所以凡视频轨不是 avc 的，上传前先在浏览器里转一遍。
 *
 * 两条路径：
 * 1. 快路径（mediabunny + WebCodecs）：浏览器能解源编码时，硬解 + 硬编 H.264，
 *    通常数倍速于实时，不下载任何 wasm。
 * 2. 兜底（ffmpeg.wasm 单线程，动态 import 单独 chunk）：浏览器解不了源编码时
 *    （典型就是 Edge 遇到 HEVC——WebCodecs 用的就是浏览器自带解码器，同样解不了）
 *    纯软件转码。慢（约 0.2~0.5x 实时），靠节点上的进度 loading 兜住体验。
 *    注意页面只设了 COOP 没设 COEP（见 matteWorker.ts），没有 SharedArrayBuffer，
 *    只能用单线程核心。
 *
 * 任何一步失败都返回原文件——转码是尽力而为的兼容性优化，不能挡住上传。
 */

// mediabunny 预打包后 1.33MB，而绝大多数会话根本不会上传需要转码的视频。静态
// import 会让它跟着 VideoNode 进入画布路由的模块图、每次打开画布都解析一遍，
// 所以这里改成首次真正要转码时才拉（同目录 audioTranscode.ts 对 lamejs 也是这么做的）。
// Promise 缓存住，并发调用只加载一次。
type MediabunnyModule = typeof import("mediabunny");
let mediabunnyPromise: Promise<MediabunnyModule> | null = null;
function loadMediabunny(): Promise<MediabunnyModule> {
  mediabunnyPromise ??= import("mediabunny");
  return mediabunnyPromise;
}

export interface EnsureWebSafeVideoResult {
  file: File;
  /** true = 发生了转码，file 是新生成的 H.264 mp4。 */
  transcoded: boolean;
}

/** 超过这个体积不做纯前端转码（wasm/内存都扛不住），原样上传。 */
const MAX_TRANSCODE_BYTES = 800 * 1024 * 1024;

/** mp4 里所有浏览器都放心的音频编码；此外的（pcm/ac3…）跟着视频一起重编成 AAC。 */
const WEB_SAFE_AUDIO = new Set(["aac", "mp3", "opus"]);

function toMp4Name(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "video"}.mp4`;
}

async function transcodeWithWebCodecs(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<File> {
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    QUALITY_HIGH,
  } = await loadMediabunny();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
    const output = new Output({
      // faststart：moov 放前面，OSS 直链流式播放不用等整个文件。
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: { codec: "avc", bitrate: QUALITY_HIGH },
      // AAC/MP3 直通不重编；其余（pcm、ac3…）重编成 AAC。opus 在 mp4 里 Safari
      // 不认，也归一到 AAC。
      audio:
        audioCodec && !["aac", "mp3"].includes(audioCodec)
          ? { codec: "aac", bitrate: 128_000 }
          : undefined,
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .map((entry) => `${entry.track.type}:${entry.reason}`)
        .join(", ");
      throw new Error(`conversion invalid (${reasons})`);
    }
    conversion.onProgress = (progress) => onProgress?.(progress);
    await conversion.execute();
    const buffer = (output.target as InstanceType<MediabunnyModule["BufferTarget"]>).buffer;
    if (!buffer || buffer.byteLength === 0) {
      throw new Error("conversion produced empty output");
    }
    return new File([buffer], toMp4Name(file.name), { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}

/**
 * ffmpeg.wasm 兜底转码（尽力而为）：动态 import 单独 chunk，转成 H.264 mp4。
 * 用于两种场景——(1) WebCodecs 快路径失败；(2) mediabunny 连容器都解析不了
 * （mxf/avi/ts 等专业或老容器，浏览器同样播不了，只能靠 ffmpeg 全能解封装）。
 * 连 ffmpeg 都失败才原样上传。
 */
async function transcodeViaFfmpegBestEffort(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<EnsureWebSafeVideoResult> {
  try {
    const { transcodeWithFfmpeg } = await import("./videoTranscodeFfmpeg");
    const converted = await transcodeWithFfmpeg(file, onProgress);
    return {
      file: new File([converted], toMp4Name(file.name), { type: "video/mp4" }),
      transcoded: true,
    };
  } catch (error) {
    console.error("[video-transcode] ffmpeg.wasm fallback failed, uploading as-is", error);
    return { file, transcoded: false };
  }
}

/**
 * 检测编码，需要时在浏览器内转成 H.264+AAC 的 mp4。
 *
 * onProgress 收 0..1；两条路径都会回调。返回的 transcoded 供调用方决定
 * 是否替换本地预览 blob（Edge 上源 HEVC 的 blob 预览同样是黑的）。
 */
export async function ensureWebSafeVideo(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<EnsureWebSafeVideoResult> {
  if (file.size > MAX_TRANSCODE_BYTES) {
    return { file, transcoded: false };
  }

  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let canDecodeSource = false;
  let width = 0;
  let height = 0;
  let probeFailed = false;
  const { ALL_FORMATS, BlobSource, canEncodeVideo, Input } = await loadMediabunny();
  const probe = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await probe.getPrimaryVideoTrack();
    if (!track) return { file, transcoded: false };
    videoCodec = await track.getCodec();
    canDecodeSource = await track.canDecode();
    width = await track.getDisplayWidth();
    height = await track.getDisplayHeight();
    const audioTrack = await probe.getPrimaryAudioTrack();
    audioCodec = audioTrack ? await audioTrack.getCodec() : null;
  } catch (error) {
    // 容器 mediabunny 解析不了（mxf/avi/ts 等专业或老容器）：浏览器多半也播不了，
    // 不能原样放行——交给 ffmpeg.wasm 全能解封装转成 H.264 mp4。
    console.warn("[video-transcode] probe failed, trying ffmpeg fallback", error);
    probeFailed = true;
  } finally {
    probe.dispose();
  }
  if (probeFailed) {
    return transcodeViaFfmpegBestEffort(file, onProgress);
  }

  const videoNeedsTranscode = videoCodec !== "avc";
  const audioNeedsTranscode = audioCodec !== null && !WEB_SAFE_AUDIO.has(audioCodec);
  if (!videoNeedsTranscode && !audioNeedsTranscode) {
    return { file, transcoded: false };
  }

  console.info(
    `[video-transcode] source codec video=${videoCodec} audio=${audioCodec} → h264/aac (decodable=${canDecodeSource})`,
  );

  // 快路径：源能被 WebCodecs 解码，且 H.264 编码可用（几乎所有 Chromium/Safari）。
  if (canDecodeSource && (await canEncodeVideo("avc", { width, height }))) {
    try {
      const converted = await transcodeWithWebCodecs(file, onProgress);
      return { file: converted, transcoded: true };
    } catch (error) {
      console.warn("[video-transcode] WebCodecs path failed, trying ffmpeg.wasm", error);
    }
  }

  // 兜底：ffmpeg.wasm 单线程软解软编（Edge 无 HEVC 解码器等场景）。
  return transcodeViaFfmpegBestEffort(file, onProgress);
}
