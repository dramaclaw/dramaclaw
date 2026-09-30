// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' ? value as JsonRecord : null;
}

function text(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function deterministicNodeOutputIssue(
  action: string,
  nodeData: unknown,
  actionOutput?: unknown,
): string | null {
  const data = record(nodeData) ?? {};
  const output = record(actionOutput) ?? {};
  const handedOff = output.submitted === true || output.status === 'submitted' || Boolean(text(
    output.task_key,
    output.taskKey,
    output.generationTaskKey,
    output.job_id,
    output.jobId,
    data.generationTaskKey,
    data.generationTaskJobId,
    data.generationJobId,
    data.taskKey,
    data.task_key,
    data.job_id,
    data.jobId,
  ));
  if (handedOff) return null;
  if (action === 'generate_image') {
    const url = text(output.imageUrl, output.image_url, output.output_url, output.url, data.imageUrl, data.image_url);
    if (!url) return '图片节点没有有效输出地址。';
    const width = finiteNumber(output.width, output.imageWidth, data.imageNaturalWidth);
    const height = finiteNumber(output.height, output.imageHeight, data.imageNaturalHeight);
    if ((width !== null && width <= 0) || (height !== null && height <= 0)) {
      return '图片输出尺寸无效。';
    }
    const expected = finiteNumber(data.count);
    const batch = Array.isArray(output.generationBatch)
      ? output.generationBatch
      : Array.isArray(data.generationBatch)
        ? data.generationBatch
        : null;
    if (expected !== null && expected > 1 && batch && batch.filter(Boolean).length < expected) {
      return `图片输出数量不足：期望 ${expected}，实际 ${batch.filter(Boolean).length}。`;
    }
  }
  if (action === 'generate_video' || action === 'generate_text_video' || action === 'auto_compose_video') {
    const url = text(
      output.videoUrl,
      output.video_url,
      output.output_url,
      output.url,
      data.videoUrl,
      data.video_url,
      data.resultVideoUrl,
    );
    if (!url) return '视频节点没有有效输出地址。';
    const durationMs = finiteNumber(output.durationMs, output.duration_ms, data.durationMs);
    if (durationMs !== null && durationMs <= 0) return '视频输出时长无效。';
  }
  if (action === 'generate_audio') {
    const url = text(output.audioUrl, output.audio_url, output.output_url, output.url, data.audioUrl, data.audio_url);
    if (!url) return '音频节点没有有效输出地址。';
    const durationMs = finiteNumber(output.durationMs, output.duration_ms, data.durationMs);
    if (durationMs !== null && durationMs <= 0) return '音频输出时长无效。';
  }
  if (action === 'generate_text' && !text(output.content, data.content)) {
    return '文本节点没有生成内容。';
  }
  return null;
}
