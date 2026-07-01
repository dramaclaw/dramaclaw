import type { ImportedStory } from './importTypes';
import { parseInkSource } from './parseInkSource';
import { parseInkJson } from './parseInkJson';

/** 按文件名/内容判格式并解析。`.json` 或以 `{` 开头 → json;否则 ink。 */
export function parseStory(text: string, filename?: string): ImportedStory {
  const looksJson = filename?.toLowerCase().endsWith('.json') || text.trim().startsWith('{');
  return looksJson ? parseInkJson(text) : parseInkSource(text);
}

export { buildStoryGroupFromImport } from './buildStoryGroupFromImport';
export { parseInkSource } from './parseInkSource';
export { parseInkJson } from './parseInkJson';
export type { ImportedStory } from './importTypes';
