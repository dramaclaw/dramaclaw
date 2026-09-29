import { describe, expect, it } from 'vitest';
import { readH3Stream } from '../api/h3-stream';

const encode = new TextEncoder();
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;

describe('H3 preview stream', () => {
  it('shows partial text before EOF and decodes split UTF-8/CRLF', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream({ start(c) { controller = c; } }));
    const seen: string[] = [];
    const output = readH3Stream(response, text => seen.push(text));
    const bytes = encode.encode(': ping\r\n\r\n' + event({ type: 'delta', text: '保持运镜' }));
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen).toEqual(['保持运镜']);
    controller.enqueue(encode.encode(event({ type: 'delta', text: '。' }) + event({ type: 'done', generated_text: '校验后文本', model: 'DeepSeek' })));
    expect(await output).toEqual({ generated_text: '校验后文本', model: 'DeepSeek' });
    expect(seen[seen.length - 1]).toBe('保持运镜。');
  });

  it.each(['eof', 'error', 'invalid'])('rejects %s after partial text', async kind => {
    const suffix = kind === 'error' ? event({ type: 'error', error: 'invalid reference' })
      : kind === 'invalid' ? event({ type: 'done', generated_text: '' }) : '';
    const response = new Response(event({ type: 'delta', text: 'unfinished' }) + suffix);
    await expect(readH3Stream(response, () => {})).rejects.toThrow();
  });

  it('releases the reader when a stream is aborted', async () => {
    const response = new Response(new ReadableStream({ start(c) { c.error(new DOMException('Cancelled', 'AbortError')); } }));
    await expect(readH3Stream(response, () => {})).rejects.toMatchObject({ name: 'AbortError' });
    expect(response.body?.locked).toBe(false);
  });
});
