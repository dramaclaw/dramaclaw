// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  extractSpeakableAudioText,
  isSpeechGenerationInstruction,
  resolveAudioKind,
  resolveMusicLengthMs,
} from '@/features/canvas/application/audioSpeechText';

describe('extractSpeakableAudioText', () => {
  it('keeps narration and dialogue while dropping production instructions', () => {
    expect(extractSpeakableAudioText(`
      【时长】79s
      【旁白】（低沉、缓慢）深夜的便利店，只有他一个人。
      【店员】（惊恐低语）它在看我。
      【环境音】冰柜压缩机低频运转
      【音效】心跳声渐强
      【配乐】低频不安氛围音乐
    `)).toBe('深夜的便利店，只有他一个人。\n\n它在看我。');
  });

  it('drops plain control lines and timeline prefixes', () => {
    expect(extractSpeakableAudioText(`
      时长：79s
      情绪：紧张
      0-5s：欢迎来到今天的节目。
      79s
    `)).toBe('欢迎来到今天的节目。');
  });

  it('preserves ordinary unstructured speech text', () => {
    expect(extractSpeakableAudioText('你好，欢迎回来。')).toBe('你好，欢迎回来。');
  });

  it('recovers a workflow BGM node that was incorrectly stored as speech', () => {
    expect(resolveAudioKind({
      audioKind: 'speech',
      title: '背景音乐',
      text: '为 15 秒广告创作背景音乐',
      workflowCatalog: {
        promptBuilder: {
          planItem: { id: 'bgm', title: '背景音乐' },
        },
      },
    })).toBe('music');
  });

  it('does not reinterpret narration as music from its body text', () => {
    expect(resolveAudioKind({
      audioKind: 'speech',
      title: '广告旁白',
      text: '欢迎收看这支背景音乐主题广告。',
    })).toBe('speech');
  });

  it('rejects a narration-generation instruction as speakable text', () => {
    const instruction =
      '根据广告脚本中的旁白文案，生成女声旁白配音，语调优雅温柔，节奏配合15秒广告';
    expect(isSpeechGenerationInstruction(instruction)).toBe(true);
    expect(extractSpeakableAudioText(instruction)).toBe('');
  });

  it('rejects workflow narration placeholders instead of speaking them literally', () => {
    expect(extractSpeakableAudioText('这是短剧的第一段旁白')).toBe('');
    expect(extractSpeakableAudioText('This is the second narration')).toBe('');
  });

  it('sets BGM one second longer than the requested video duration', () => {
    expect(resolveMusicLengthMs({
      audioKind: 'music',
      text: '生成优雅背景音乐',
      workflowCatalog: {
        promptBuilder: {
          userGoal: '制作一条 15 秒竖屏广告',
        },
      },
    })).toBe(16_000);
  });
});
