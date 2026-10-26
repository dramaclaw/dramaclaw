import { describe, expect, it } from 'vitest';
import { correctedTimeline, readableTranscript, segmentWordGroups, sourceMediaForTranscript, sourceScriptForTranscript, timelineSegments, transcriptPlaybackParts, transcriptSrt, timelineWords } from './transcriptModel';

const timeline = {
  schema: 'word_timeline.v1', media_hash: 'hash', language: 'zh', status: 'completed', transcript: '你好',
  words: [
    { text: '你', start_char: 0, end_char: 1, start_us: 0, end_us: 500_000, confidence: 0.4 },
    { text: '好', start_char: 1, end_char: 2, start_us: 500_000, end_us: 1_000_000, confidence: 0.9 },
  ],
};

describe('transcript node model', () => {
  it('restores spaces for an existing collapsed English transcript without altering Chinese or complete prose', () => {
    const words = [
      { text: 'Okay', startUs: 0, endUs: 300_000, startChar: 0, endChar: 4 },
      { text: 'Sarah', startUs: 400_000, endUs: 700_000, startChar: 4, endChar: 9 },
      { text: 'so', startUs: 800_000, endUs: 900_000, startChar: 9, endChar: 11 },
    ];
    const restored = readableTranscript('OkaySarahso', words);
    expect(restored).toBe('Okay Sarah so');
    expect(transcriptPlaybackParts(restored, words)).toEqual([
      { text: 'Okay', startUs: 0, endUs: 300_000 }, { text: ' ' },
      { text: 'Sarah', startUs: 400_000, endUs: 700_000 }, { text: ' ' },
      { text: 'so', startUs: 800_000, endUs: 900_000 },
    ]);
    expect(readableTranscript('Okay, Sarah, so', words)).toBe('Okay, Sarah, so');
    expect(readableTranscript('你好', [
      { text: '你', startUs: 0, endUs: 100_000 },
      { text: '好', startUs: 100_000, endUs: 200_000 },
    ])).toBe('你好');
    expect(readableTranscript('flour', ['f', 'l', 'o', 'u', 'r'].map((text, index) => ({ text, startUs: index * 100_000, endUs: (index + 1) * 100_000 })))).toBe('flour');
  });

  it('preserves separators and repeated words when preparing playback links', () => {
    expect(transcriptPlaybackParts('go, go!', [
      { text: 'go', startUs: 100_000, endUs: 200_000 },
      { text: 'go', startUs: 500_000, endUs: 600_000 },
    ])).toEqual([
      { text: 'go', startUs: 100_000, endUs: 200_000 }, { text: ', ' },
      { text: 'go', startUs: 500_000, endUs: 600_000 }, { text: '!' },
    ]);
    expect(transcriptPlaybackParts('corrected text', [{ text: 'old', startUs: 0, endUs: 100_000 }])).toEqual([{ text: 'corrected text' }]);
    expect(transcriptPlaybackParts('other the', [{ text: 'the', startUs: 500_000, endUs: 600_000, startChar: 6, endChar: 9 }])).toEqual([
      { text: 'other ' }, { text: 'the', startUs: 500_000, endUs: 600_000 },
    ]);
    expect(transcriptPlaybackParts('😀其他他', [{ text: '他', startUs: 500_000, endUs: 600_000, startChar: 3, endChar: 4 }])).toEqual([
      { text: '😀其他' }, { text: '他', startUs: 500_000, endUs: 600_000 },
    ]);
  });

  it('groups legacy character-level English timing into word-sized playback parts', () => {
    expect(transcriptPlaybackParts('flour and water', [
      { text: 'f', startUs: 0, endUs: 100_000, startChar: 0, endChar: 1 },
      { text: 'l', startUs: 100_000, endUs: 200_000, startChar: 1, endChar: 2 },
      { text: 'o', startUs: 200_000, endUs: 300_000, startChar: 2, endChar: 3 },
      { text: 'u', startUs: 300_000, endUs: 400_000, startChar: 3, endChar: 4 },
      { text: 'r', startUs: 400_000, endUs: 500_000, startChar: 4, endChar: 5 },
      { text: 'and', startUs: 600_000, endUs: 900_000, startChar: 6, endChar: 9 },
      { text: 'water', startUs: 1_000_000, endUs: 1_300_000, startChar: 10, endChar: 15 },
    ])).toEqual([
      { text: 'flour', startUs: 0, endUs: 500_000 },
      { text: ' ' },
      { text: 'and', startUs: 600_000, endUs: 900_000 },
      { text: ' ' },
      { text: 'water', startUs: 1_000_000, endUs: 1_300_000 },
    ]);
  });

  it('chooses connected narration before video and ignores sources without a remix media path', () => {
    const nodes = [
      { id: 'video', data: { remixMedia: { media_path: 'video.mp4', media_kind: 'video', has_audio: true } } },
      { id: 'audio', data: { remixMedia: { media_path: 'speech.wav', media_kind: 'audio' } } },
      { id: 'external', data: { audioUrl: 'https://example.com/speech.wav' } },
    ];
    const edges = [{ source: 'video', target: 'transcript' }, { source: 'audio', target: 'transcript' }, { source: 'external', target: 'transcript' }];
    expect(sourceMediaForTranscript('transcript', nodes, edges)).toEqual({ path: 'speech.wav', url: undefined, kind: 'audio' });
    expect(sourceMediaForTranscript('transcript', nodes.slice(0, 1), edges)).toEqual({ path: 'video.mp4', url: undefined, kind: 'video' });
  });

  it('turns artifact words into the canvas word representation', () => {
    expect(timelineWords(timeline)).toEqual([
      { text: '你', startUs: 0, endUs: 500_000, startChar: 0, endChar: 1, confidence: 0.4 },
      { text: '好', startUs: 500_000, endUs: 1_000_000, startChar: 1, endChar: 2, confidence: 0.9 },
    ]);
  });

  it('uses a connected script artifact for forced alignment', () => {
    const nodes = [{ id: 'script', data: { remixScriptRef: { artifactId: 'script-1', revision: 2 } } }];
    expect(sourceScriptForTranscript('transcript', nodes, [{ source: 'script', target: 'transcript' }])).toEqual({ artifactId: 'script-1', revision: 2 });
    expect(sourceScriptForTranscript('transcript', nodes, [])).toBeNull();
  });

  it('rebuilds character spans and transcript when a word is corrected', () => {
    expect(correctedTimeline(timeline, ['您', '好'], true).words).toEqual([
      expect.objectContaining({ text: '您', start_char: 0, end_char: 1, start_us: 0, end_us: 500_000 }),
      expect.objectContaining({ text: '好', start_char: 1, end_char: 2, start_us: 500_000, end_us: 1_000_000 }),
    ]);
    expect(correctedTimeline(timeline, ['您', '好'], true).transcript).toBe('您好');
    expect(correctedTimeline(timeline, ['您', '好'], true).words[0]).toMatchObject({ timing_status: 'manually_verified', original_text: '你' });
    expect(() => correctedTimeline(timeline, ['', '好'], true)).toThrow('字词不能为空');
  });

  it('preserves separators in word-level transcripts when a word is corrected', () => {
    const wordTimeline = {
      ...timeline,
      transcript: 'go home',
      words: [
        { text: 'go', start_char: 0, end_char: 2, start_us: 0, end_us: 200_000 },
        { text: 'home', start_char: 3, end_char: 7, start_us: 300_000, end_us: 700_000 },
      ],
    };

    expect(correctedTimeline(wordTimeline, ['Go', 'home'], true).transcript).toBe('Go home');
  });

  it('requires explicit same-speech confirmation even when a replacement has the same length', () => {
    expect(() => correctedTimeline(timeline, ['您', '好'], false)).toThrow('需要重新对齐');
  });

  it('allows a confirmed single English word spelling correction while rebuilding offsets', () => {
    const wordTimeline = {
      ...timeline,
      transcript: 'Christine, five grams',
      words: [
        { text: 'Christine,', start_char: 0, end_char: 10, start_us: 0, end_us: 400_000 },
        { text: 'five', start_char: 11, end_char: 15, start_us: 500_000, end_us: 700_000 },
        { text: 'grams', start_char: 16, end_char: 21, start_us: 800_000, end_us: 1_000_000 },
      ],
    };
    const revised = correctedTimeline(wordTimeline, ['Creatine,', 'five', 'grams'], true);
    expect(revised.transcript).toBe('Creatine, five grams');
    expect(revised.words[1]).toMatchObject({ start_char: 10, end_char: 14, start_us: 500_000 });
    expect(revised.words[0]).toMatchObject({ timing_status: 'manually_verified', original_text: 'Christine,' });
  });

  it('rejects changed word length or boundaries despite confirmation', () => {
    expect(() => correctedTimeline(timeline, ['您好', '好'], true)).toThrow('需要重新对齐');
    expect(() => correctedTimeline(timeline, ['你 好', '好'], true)).toThrow('需要重新对齐');
  });

  it('exports playable SRT timing', () => {
    expect(transcriptSrt(timelineWords(timeline))).toBe('1\n00:00:00,000 --> 00:00:00,500\n你\n\n2\n00:00:00,500 --> 00:00:01,000\n好\n');
  });

  it('keeps provider sentences in reading order and ignores empty or backwards ones', () => {
    const segments = timelineSegments({
      ...timeline,
      segments: [
        { text: '第二句', start_us: 2_000_000, end_us: 3_000_000 },
        { text: '第一句', start_us: 0, end_us: 1_000_000 },
        { text: '   ', start_us: 1_000_000, end_us: 2_000_000 },
        { text: '倒序', start_us: 5_000_000, end_us: 4_000_000 },
      ],
    } as never);

    expect(segments).toEqual([
      { text: '第一句', startUs: 0, endUs: 1_000_000 },
      { text: '第二句', startUs: 2_000_000, endUs: 3_000_000 },
    ]);
    expect(timelineSegments(timeline as never)).toEqual([]);
  });

  it('groups words by sentence while keeping each word global index', () => {
    const words = timelineWords(timeline);
    const groups = segmentWordGroups(timelineSegments({
      ...timeline,
      segments: [
        { text: '你', start_us: 0, end_us: 500_000 },
        { text: '好', start_us: 500_000, end_us: 1_000_000 },
      ],
    } as never), words);

    expect(groups.map((group) => group.segment.text)).toEqual(['你', '好']);
    expect(groups.map((group) => group.words.map(({ word, index }) => [word.text, index]))).toEqual([[['你', 0]], [['好', 1]]]);
  });

  it('assigns a word straddling a sentence boundary to the sentence containing its midpoint', () => {
    const words = [
      { text: '跨', startUs: 400_000, endUs: 1_200_000 },
      { text: '句', startUs: 1_200_000, endUs: 1_500_000 },
    ];
    const groups = segmentWordGroups([
      { text: '前', startUs: 0, endUs: 1_000_000 },
      { text: '后', startUs: 1_000_000, endUs: 2_000_000 },
    ], words);

    expect(groups.map((group) => group.words.map(({ word, index }) => [word.text, index]))).toEqual([[['跨', 0]], [['句', 1]]]);
  });
});


it('plays a restored native transcript from its immutable source without remix metadata', () => {
  const data = {sourceProjectId:'demo',sourceMediaPath:'video.mp4',sourceMediaHash:'genuine-hash',sourceVideoUrl:'/static/projects/demo/video.mp4',words:[{text:'hello'}]};
  const nodes: Array<{id:string;data:Record<string,unknown>}> = [{id:'source',data:{videoUrl:'/static/projects/demo/video.mp4'}},{id:'words',data}];
  const edges = [{source:'source',target:'words'}];
  expect(sourceMediaForTranscript('words',nodes,edges)).toEqual({path:'video.mp4',url:'/static/projects/demo/video.mp4',kind:'video'});
  nodes[0].data.videoUrl = '/changed.mp4';
  expect(sourceMediaForTranscript('words',nodes,edges)).toBeNull();
});


it.each([
  ['../outside.mp4','/static/projects/demo/video.mp4'],
  ['/etc/video.mp4','/static/projects/demo/video.mp4'],
  ['video.mp4','https://other.example/static/projects/demo/video.mp4'],
  ['video.mp4','/static/projects/peer/video.mp4'],
])('rejects a restored transcript playback source outside its original project: %s', (path,url) => {
  const nodes = [{id:'source',data:{videoUrl:url}},{id:'words',data:{sourceProjectId:'demo',sourceMediaPath:path,sourceMediaHash:'hash',sourceVideoUrl:url}}];
  expect(sourceMediaForTranscript('words',nodes,[{source:'source',target:'words'}])).toBeNull();
});
