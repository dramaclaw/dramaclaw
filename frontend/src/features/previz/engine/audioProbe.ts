// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 用一个不挂进文档的 `<audio>` 读素材时长（毫秒）。本地文件走 object URL，
 * 上游节点没记时长时走它的 url。读不出有限值就当上传失败处理，由调用方提示。
 */
export function probeAudioDuration(source: File | string): Promise<number> {
  return new Promise((resolve, reject) => {
    const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const cleanup = () => {
      audio.removeAttribute('src');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    audio.onloadedmetadata = () => {
      const seconds = audio.duration;
      cleanup();
      if (!Number.isFinite(seconds) || seconds <= 0) {
        reject(new Error('audio duration unavailable'));
        return;
      }
      resolve(Math.round(seconds * 1000));
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('audio metadata failed'));
    };
    audio.src = objectUrl ?? (source as string);
  });
}
