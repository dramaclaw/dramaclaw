// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { OUTPUT_PIXEL_SIZE } from '../domain/camera';
import type { OutputAspect } from '../domain/scene';

/**
 * 录制的驱动循环。它只管「什么时候画第几帧、什么时候收工」，画什么由 `drawFrame`
 * 决定，编码交给 `recorder`——这样单测不需要 WebGL，也不需要 MediaRecorder。
 *
 * 为什么按**真实耗时**换算帧号，而不是每次调度推进一帧：`MediaRecorder` 给每一帧打的
 * 时间戳来自墙上时钟，不是我们喂了几帧。渲染比实时慢的时候，「每次推一帧」录出来的
 * 视频会整体放慢（30 帧的走位被摊到 3 秒里），而按耗时取帧只是丢帧——动作快慢仍然对，
 * 这是两害里明显轻的那个。
 */

/** 录制画面的每秒帧数。与 `PREVIZ_FPS` 同值，但这里是编码侧的采样率，不是时间轴单位。 */
export const PREVIZ_RECORD_FPS = 30;

/**
 * 走完最后一帧之后再多录这么久。`captureStream` 是按固定间隔去采样画布的，
 * 画完立刻 stop 的话最后一帧可能一次都没被采到，成片会缺尾。
 */
const TAIL_SECONDS = 0.25;

export interface RecorderLike {
  start(): void;
  /** 停止并交出成片。多次调用只认第一次。 */
  stop(): Promise<Blob>;
}

export interface RecordTimelineDeps {
  /** 时间轴总帧数；录制从第 0 帧走到这一帧。 */
  durationFrames: number;
  fps: number;
  /** 解算并画出某一帧。 */
  drawFrame: (frame: number) => void;
  recorder: RecorderLike;
  now: () => number;
  /** 排下一次检查。浏览器里是 requestAnimationFrame。 */
  schedule: (callback: () => void) => void;
  /** 每次真正画了新的一帧时回报进度，取值 0..1。 */
  onProgress?: (ratio: number) => void;
  /** 返回 true 就提前收工（用户点了停止）。已画的部分照常出片。 */
  shouldStop?: () => boolean;
}

export async function recordTimeline(deps: RecordTimelineDeps): Promise<Blob> {
  const fps = deps.fps > 0 ? deps.fps : PREVIZ_RECORD_FPS;
  const lastFrame = Math.max(0, Math.round(deps.durationFrames));
  const totalSeconds = lastFrame / fps;

  // 先画第 0 帧再开录：反过来的话编码器开头会采到上一次留在画布上的内容。
  deps.drawFrame(0);
  deps.onProgress?.(0);
  deps.recorder.start();

  const startedAt = deps.now();
  await new Promise<void>((resolve) => {
    let painted = 0;
    const step = () => {
      const elapsed = (deps.now() - startedAt) / 1000;
      if (deps.shouldStop?.()) {
        resolve();
        return;
      }
      const frame = Math.min(lastFrame, Math.max(0, Math.round(elapsed * fps)));
      if (frame !== painted) {
        painted = frame;
        deps.drawFrame(frame);
        deps.onProgress?.(lastFrame > 0 ? frame / lastFrame : 1);
      }
      if (elapsed >= totalSeconds + TAIL_SECONDS) {
        resolve();
        return;
      }
      deps.schedule(step);
    };
    deps.schedule(step);
  });

  return await deps.recorder.stop();
}

/**
 * 挑一个浏览器真的能编的容器。mp4 排在前面：画布上的视频节点、后续的合成与下载
 * 都按 mp4 走得最顺，webm 只是退路。
 */
const VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/**
 * 带音轨的候选。mp4 配 AAC，webm 配 Opus；顺序同无声版，先 mp4 后 webm。
 * 裸的 'video/mp4' / 'video/webm' 留在这里是为了 Safari：它只报告裸类型支持，但录出来
 * 确实带 AAC。裸类型最终有没有把声音混进去由浏览器决定。
 */
const MIXED_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

export function pickRecordMimeType(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
  withAudio = false,
): string | null {
  const candidates = withAudio ? MIXED_MIME_CANDIDATES : VIDEO_MIME_CANDIDATES;
  for (const candidate of candidates) {
    if (isSupported(candidate)) return candidate;
  }
  return null;
}

/** `video/mp4;codecs=avc1` → `mp4`。认不出来的一律当 webm，别造出没有后缀的文件名。 */
export function extensionForRecordMime(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

/** `previz-record-20260904T101112.mp4`：可排序，同一秒内不至于重名到看不出来。 */
export function recordFilename(now: number, mimeType: string): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `previz-record-${stamp}.${extensionForRecordMime(mimeType)}`;
}

/**
 * 节点标题里那半截画质说明，例如 `1080p 16:9`。取短边而不是高：竖幅出片的短边
 * 才是大家嘴里那个「1080p」。
 */
export function recordQualityLabel(aspect: OutputAspect): string {
  const { width, height } = OUTPUT_PIXEL_SIZE[aspect];
  return `${Math.min(width, height)}p ${aspect}`;
}

export interface CanvasRecorderOptions {
  fps: number;
  mimeType: string;
  /** 码率。1080p30 给 12 Mbps：再低运镜时的网格会糊成一团块。 */
  videoBitsPerSecond?: number;
  /** 音频轨的混音流；给了就并进画布流，MediaRecorder 会把它编成音轨。 */
  audioStream?: MediaStream;
}

/**
 * 浏览器实现：把一块 2D 画布接到 `MediaRecorder` 上。
 *
 * 用 `captureStream(fps)` 而不是 `captureStream(0)` + `requestFrame()`：后者能精确
 * 控制每一帧，但 `requestFrame` 不是所有浏览器都有，缺了就整条路径静默不出帧。
 * 定速采样在渲染跟不上时只是重复上一帧，退化得体面。
 */
export function createCanvasRecorder(
  canvas: HTMLCanvasElement,
  options: CanvasRecorderOptions,
): RecorderLike {
  const stream = canvas.captureStream(options.fps);
  // 并进来之后这些音轨就归这条流管，下面的 `stopTracks` 会连它们一起停。这是有意的——
  // 调用方的混音流是为这一次录制建的，录完就该收。
  for (const track of options.audioStream?.getAudioTracks() ?? []) {
    stream.addTrack(track);
  }
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: options.mimeType,
      videoBitsPerSecond: options.videoBitsPerSecond ?? 12_000_000,
    });
  } catch (error) {
    // 音轨已经归这里管了：构造器没起来也得放掉，不然音频采集口会一直开着。
    stopTracks();
    throw error;
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  let settled: Promise<Blob> | null = null;
  return {
    start() {
      // 给一个切片间隔：不给的话整段录制只在 stop 时吐一个 chunk，长录制期间
      // 内存里攒的是一整条未切分的流，中途出错什么都拿不回来。
      recorder.start(1000);
    },
    stop() {
      settled ??= new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          stopTracks();
          resolve(new Blob(chunks, { type: options.mimeType }));
        };
        recorder.onerror = (event) => {
          stopTracks();
          reject(event instanceof Error ? event : new Error('previz record: MediaRecorder failed'));
        };
        // 已经停了（编码器自己出错停下的）时再调 stop() 会抛 InvalidStateError，
        // 那时 onstop 也永远不会来，Promise 会挂死——直接按已停处理。
        if (recorder.state === 'inactive') {
          stopTracks();
          resolve(new Blob(chunks, { type: options.mimeType }));
          return;
        }
        recorder.stop();
      });
      return settled;
    },
  };
}
