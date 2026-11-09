import { describe, expect, it } from 'vitest';
import enTranslation from '../../../../public/locales/en/translation.json';
import ptTranslation from '../../../../public/locales/pt/translation.json';
import viTranslation from '../../../../public/locales/vi/translation.json';
import zhTranslation from '../../../../public/locales/zh/translation.json';
import { CANVAS_NODE_TYPES } from './canvasNodes';

const LOCALES = { en: enTranslation, pt: ptTranslation, vi: viTranslation, zh: zhTranslation };

describe('node.displayName locale coverage', () => {
  it.each(Object.entries(LOCALES))('%s has a display name for every canvas node type', (_, translation) => {
    const displayNames = (translation as { node: { displayName: Record<string, unknown> } }).node
      .displayName;
    const missing = Object.values(CANVAS_NODE_TYPES).filter(
      (type) => typeof displayNames[type] !== 'string' || !displayNames[type],
    );
    expect(missing).toEqual([]);
  });
});
