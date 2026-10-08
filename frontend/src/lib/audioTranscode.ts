// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// In-browser audio format conversion for the canvas audio-node download menu.
//
// The backend serves the separated/generated audio in whatever container it
// produced (audio separate now emits `.mp3`; older results are AAC-in-`.m4a`).
// When the user downloads, we let them pick a target format. Conversions run
// entirely client-side:
//
// - WAV  — decode → 16-bit PCM → RIFF header. Pure JS, no deps, lossless re-wrap.
// - MP3  — decode → 16-bit PCM → lamejs encoder.
// - M4A  — browsers can *decode* AAC but cannot *encode* it without a heavy
//          ffmpeg.wasm payload, so m4a is only offered as a passthrough of the
//          original bytes (i.e. when the source is already m4a/aac/mp4). See
//          `canProduceFormat`.
//
// Decoding goes through the Web Audio API (`decodeAudioData`), which handles any
// container the browser can play (mp3 / m4a / aac / wav / ogg / flac).
//
// The lamejs MP3 encoder (~170 KB) is loaded lazily inside `encodeMp3` so it only
// ships to users who actually export MP3.

export type AudioDownloadFormat = "mp3" | "m4a" | "wav";

export const AUDIO_DOWNLOAD_FORMATS: readonly AudioDownloadFormat[] = [
  "mp3",
  "m4a",
  "wav",
] as const;

const FORMAT_MIME: Record<AudioDownloadFormat, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

// Source extensions that are the AAC-in-MP4 family — m4a download can only be a
// passthrough of one of these (browsers can't encode AAC client-side).
const M4A_SOURCE_EXTS = new Set(["m4a", "aac", "mp4", "m4b"]);

const MP3_KBPS = 192;
const MP3_BLOCK_SIZE = 1152;

/** Lower-cased file extension parsed from a URL (no leading dot), or "". */
export function getAudioExtFromUrl(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const match = clean.match(/\.([a-z0-9]{1,5})$/i);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Whether `target` can be produced in-browser from a source with `sourceExt`.
 * mp3/wav are always producible (decode + encode). m4a only when the source is
 * already an AAC/MP4 container, in which case we pass the bytes through untouched.
 */
export function canProduceFormat(
  target: AudioDownloadFormat,
  sourceExt: string,
): boolean {
  if (target === "m4a") return M4A_SOURCE_EXTS.has(sourceExt);
  return true;
}

/** True when the target equals the source container, so no re-encode is needed. */
function isPassthrough(target: AudioDownloadFormat, sourceExt: string): boolean {
  if (target === "m4a") return M4A_SOURCE_EXTS.has(sourceExt);
  return target === sourceExt;
}

function decodeToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    return Promise.reject(new Error("Web Audio API unavailable"));
  }
  const ctx = new Ctor();
  return blob.arrayBuffer().then(
    (arrayBuffer) =>
      // Callback form is supported everywhere (incl. older Safari). decodeAudioData
      // detaches the input buffer, which is fine — we don't reuse it.
      new Promise<AudioBuffer>((resolve, reject) => {
        ctx.decodeAudioData(
          arrayBuffer,
          (buffer) => {
            void ctx.close();
            resolve(buffer);
          },
          (err) => {
            void ctx.close();
            reject(err ?? new Error("decodeAudioData failed"));
          },
        );
      }),
  );
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;

  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: FORMAT_MIME.wav });
}

async function encodeMp3(buffer: AudioBuffer): Promise<Blob> {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const numChannels = Math.min(buffer.numberOfChannels, 2);
  const encoder = new Mp3Encoder(numChannels, buffer.sampleRate, MP3_KBPS);
  const left = floatTo16BitPCM(buffer.getChannelData(0));
  const right =
    numChannels > 1 ? floatTo16BitPCM(buffer.getChannelData(1)) : undefined;

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += MP3_BLOCK_SIZE) {
    const leftChunk = left.subarray(i, i + MP3_BLOCK_SIZE);
    const mp3buf = right
      ? encoder.encodeBuffer(leftChunk, right.subarray(i, i + MP3_BLOCK_SIZE))
      : encoder.encodeBuffer(leftChunk);
    if (mp3buf.length > 0) chunks.push(mp3buf);
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);
  return new Blob(chunks as BlobPart[], { type: FORMAT_MIME.mp3 });
}

/**
 * Convert `blob` (the source audio bytes) to `target`. When the requested format
 * matches the source container the original bytes are returned untouched (no
 * lossy re-encode). Throws if `target` can't be produced for this source (m4a
 * from a non-AAC source) — callers should gate on `canProduceFormat` first.
 */
export async function transcodeAudio(
  blob: Blob,
  sourceExt: string,
  target: AudioDownloadFormat,
): Promise<Blob> {
  if (isPassthrough(target, sourceExt)) return blob;
  if (target === "m4a") {
    throw new Error("m4a cannot be encoded in-browser");
  }
  const audioBuffer = await decodeToAudioBuffer(blob);
  return target === "wav"
    ? encodeWav(audioBuffer)
    : await encodeMp3(audioBuffer);
}
