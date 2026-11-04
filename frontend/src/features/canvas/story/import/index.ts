import type { ImportedStory } from './importTypes';
import { compileInkSource } from './compileInkSource';
import { parseInkJson } from './parseInkJson';

/**
 * 按文件名/内容判格式并解析。`.json` 或以 `{` 开头 → 直接当 story JSON;
 * 否则视作 ink 源码,先用 inkjs 编译再走同一条 JSON 解析路径。
 */
export function parseStory(text: string, filename?: string): ImportedStory {
  const looksJson = filename?.toLowerCase().endsWith('.json') || text.trim().startsWith('{');
  if (looksJson) return parseInkJson(text);
  const { json, warnings } = compileInkSource(text);
  const story = parseInkJson(json);
  story.warnings.unshift(...warnings);
  return story;
}

export { buildStoryGroupFromImport } from './buildStoryGroupFromImport';
export { compileInkSource, InkCompileError } from './compileInkSource';
export { parseInkJson } from './parseInkJson';
export type { ImportedStory } from './importTypes';
