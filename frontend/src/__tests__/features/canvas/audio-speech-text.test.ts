// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  extractExplicitSpeakableAudioText,
  extractSpeakableAudioText,
  isSpeechGenerationInstruction,
  resolveAudioKind,
  resolveMusicLengthMs,
  resolveSafeSpeechSubmissionText,
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

  it('uses only the pre-filtered narration when Recipe compilation times out', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'timeout_fallback',
      compiledPrompt: '你是短剧配音导演。请根据脚本生成旁白。\n\n真正的旁白。',
      safeFallbackPrompt: '真正的旁白。',
    })).toBe('真正的旁白。');
  });

  it('stops timeout fallback submission when no safe narration exists', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'timeout_fallback',
      compiledPrompt: '你是短剧配音导演。请根据脚本生成旁白。',
      safeFallbackPrompt: '',
    })).toBe('');
  });

  it('uses a successful Recipe compilation result for speech', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '【旁白】编译后的安全旁白。',
      safeFallbackPrompt: '原始旁白。',
    })).toBe('编译后的安全旁白。');
  });

  it('extracts only explicitly labelled speech from a general-audio production brief', () => {
    const compiled = '女声普通话旁白，情绪温柔，时长 3 秒。朗读文本：欢迎使用。';
    expect(extractExplicitSpeakableAudioText(compiled)).toBe('欢迎使用。');
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: compiled,
      recipeIds: ['general-audio'],
      safeFallbackPrompt: '原始文本。',
    })).toBe('欢迎使用。');
  });

  it('stops explicit speech collection when another production field starts', () => {
    const compiled = [
      '朗读文本：',
      '<speech_text>',
      '欢迎使用。',
      '他说：快跑。',
      '</speech_text>',
      '情感：温柔',
      '音色描述：温柔女声',
    ].join('\n');
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: compiled,
      recipeIds: ['general-audio'],
      safeFallbackPrompt: '原始文本。',
    })).toBe('欢迎使用。\n\n他说：快跑。');
  });

  it('falls back safely when structured speech markers are missing', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '朗读文本：\n他说：快跑。\n情感：温柔',
      recipeIds: ['general-audio'],
      safeFallbackPrompt: '原始旁白。',
    })).toBe('原始旁白。');
  });

  it('accepts an unlabelled model result from the direct-speech Recipe', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '他说：快跑。',
      recipeIds: ['drama-shot-voice'],
      safeFallbackPrompt: '原始旁白。',
    })).toBe('他说：快跑。');
  });

  it('rejects labelled production output from the direct-speech Recipe', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '【音色】温柔女声',
      recipeIds: ['drama-shot-voice'],
      safeFallbackPrompt: '原始旁白。',
    })).toBe('原始旁白。');
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '制作要求：句尾自然收音。',
      recipeIds: ['drama-shot-voice'],
      safeFallbackPrompt: '原始旁白。',
    })).toBe('原始旁白。');
  });

  it('does not accept unlabelled production output from a general audio Recipe', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '温柔女声，节奏舒缓。',
      recipeIds: ['general-audio'],
      safeFallbackPrompt: '原始旁白。',
    })).toBe('原始旁白。');
  });

  it('falls back to source speech when a model result has no explicit speech field', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '女声普通话旁白，情绪温柔，时长 3 秒。',
      safeFallbackPrompt: '欢迎使用。',
    })).toBe('欢迎使用。');
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
