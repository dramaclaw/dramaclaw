export interface H3StreamResult { generated_text: string; model: string }

/** A closed connection is not success: only a validated done event is usable. */
export async function readH3Stream(
  response: Response,
  onText: (text: string) => void,
): Promise<H3StreamResult> {
  if (!response.body) throw new Error('Model stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let data: string[] = [];
  let result: H3StreamResult | undefined;
  const dispatch = () => {
    if (!data.length) return;
    const event = JSON.parse(data.join('\n'));
    data = [];
    if (event.type === 'error') throw new Error(event.error || 'Model stream failed');
    if (event.type === 'delta' && typeof event.text === 'string') {
      text += event.text;
      onText(text);
    }
    if (event.type === 'done') {
      if (typeof event.generated_text !== 'string' || !event.generated_text.trim() || typeof event.model !== 'string') {
        throw new Error('Invalid model stream result');
      }
      result = { generated_text: event.generated_text, model: event.model };
    }
  };
  try {
    while (!result) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!line) dispatch();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (result) break;
      }
      if (done) break;
    }
    if (!result) throw new Error('Model stream ended before validation completed');
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
