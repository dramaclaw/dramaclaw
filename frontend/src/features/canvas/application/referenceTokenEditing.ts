// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export type DeleteDirection = 'backward' | 'forward';

export interface TextRange {
  start: number;
  end: number;
}

export interface ReferenceTokenMatch extends TextRange {
  token: string;
  value: number;
}

interface TokenRange extends TextRange {
  blockStart: number;
  blockEnd: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveMaxReferenceNumber(maxImageCount?: number): number {
  if (typeof maxImageCount !== 'number' || !Number.isFinite(maxImageCount)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, Math.floor(maxImageCount));
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

export function findReferenceTokens(text: string, maxImageCount?: number): ReferenceTokenMatch[] {
  const tokens: ReferenceTokenMatch[] = [];
  const maxReferenceNumber = resolveMaxReferenceNumber(maxImageCount);

  for (let index = 0; index < text.length; index += 1) {
    // `@图N` 是写进提示词、模型认的引用 token，跟界面语言无关。
    if (text[index] !== '@' || text[index + 1] !== '图') { // i18n-exempt —— 提示词 token
      continue;
    }

    const digitsStart = index + 2;
    if (!isAsciiDigit(text[digitsStart] ?? '')) {
      continue;
    }

    let digitsEnd = digitsStart;
    while (isAsciiDigit(text[digitsEnd] ?? '')) {
      digitsEnd += 1;
    }

    if (maxReferenceNumber === Number.POSITIVE_INFINITY) {
      const fullValue = Number(text.slice(digitsStart, digitsEnd));
      if (Number.isFinite(fullValue) && fullValue >= 1) {
        tokens.push({
          start: index,
          end: digitsEnd,
          token: text.slice(index, digitsEnd),
          value: fullValue,
        });
        index = digitsEnd - 1;
      }
      continue;
    }

    let bestEnd = -1;
    let bestValue = 0;
    let rollingValue = 0;
    for (let cursor = digitsStart; cursor < digitsEnd; cursor += 1) {
      rollingValue = rollingValue * 10 + Number(text[cursor]);

      if (rollingValue >= 1 && rollingValue <= maxReferenceNumber) {
        bestEnd = cursor + 1;
        bestValue = rollingValue;
      }

      if (rollingValue > maxReferenceNumber) {
        break;
      }
    }

    if (bestEnd > 0) {
      tokens.push({
        start: index,
        end: bestEnd,
        token: text.slice(index, bestEnd),
        value: bestValue,
      });
      index = bestEnd - 1;
    }
  }

  return tokens;
}

/**
 * 找出与 [selectionStart, selectionEnd] 选区重叠的 `@图N` token —— 双击 textarea 时
 * 浏览器会选中 token 里的某个「词」，据此定位用户双击的是哪个引用 token。无命中返回 null。
 */
export function findReferenceTokenAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  maxImageCount?: number,
): ReferenceTokenMatch | null {
  return (
    findReferenceTokens(text, maxImageCount).find(
      (token) => token.start < selectionEnd && token.end > selectionStart,
    ) ?? null
  );
}

/** 把 [range.start, range.end) 段整体替换成 `marker`，返回新文本与替换后光标位置。 */
export function replaceReferenceToken(
  text: string,
  range: TextRange,
  marker: string,
): { nextText: string; nextCursor: number } {
  const nextText = text.slice(0, range.start) + marker + text.slice(range.end);
  return { nextText, nextCursor: range.start + marker.length };
}

function findTokenRanges(text: string, maxImageCount?: number): TokenRange[] {
  const ranges: TokenRange[] = [];
  const referenceTokens = findReferenceTokens(text, maxImageCount);
  for (const token of referenceTokens) {
    const start = token.start;
    const end = token.end;
    const blockStart = start > 0 && text[start - 1] === ' ' ? start - 1 : start;
    const blockEnd = end < text.length && text[end] === ' ' ? end + 1 : end;

    ranges.push({
      start,
      end,
      blockStart,
      blockEnd,
    });
  }

  return ranges;
}

export function insertReferenceToken(
  text: string,
  cursor: number,
  marker: string
): { nextText: string; nextCursor: number } {
  const safeCursor = clamp(cursor, 0, text.length);
  const before = text.slice(0, safeCursor);
  const after = text.slice(safeCursor);
  const previousChar = before.length > 0 ? before.charAt(before.length - 1) : '';
  const nextChar = after.length > 0 ? after.charAt(0) : '';
  const needsLeadingSpace = before.length > 0 && !/\s/.test(previousChar);
  const needsTrailingSpace = !(after.length > 0 && /\s/.test(nextChar));
  const insertion = `${needsLeadingSpace ? ' ' : ''}${marker}${needsTrailingSpace ? ' ' : ''}`;

  return {
    nextText: `${before}${insertion}${after}`,
    nextCursor: before.length + insertion.length,
  };
}

export function resolveReferenceAwareDeleteRange(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  direction: DeleteDirection,
  maxImageCount?: number
): TextRange | null {
  const safeStart = clamp(selectionStart, 0, text.length);
  const safeEnd = clamp(selectionEnd, 0, text.length);
  const selectionMin = Math.min(safeStart, safeEnd);
  const selectionMax = Math.max(safeStart, safeEnd);
  const tokenRanges = findTokenRanges(text, maxImageCount);

  if (selectionMin !== selectionMax) {
    let expandedStart = selectionMin;
    let expandedEnd = selectionMax;
    let touchedToken = false;

    for (const tokenRange of tokenRanges) {
      if (tokenRange.blockEnd <= expandedStart || tokenRange.blockStart >= expandedEnd) {
        continue;
      }

      touchedToken = true;
      expandedStart = Math.min(expandedStart, tokenRange.blockStart);
      expandedEnd = Math.max(expandedEnd, tokenRange.blockEnd);
    }

    if (!touchedToken) {
      return null;
    }

    return {
      start: expandedStart,
      end: expandedEnd,
    };
  }

  const point = direction === 'backward'
    ? Math.max(0, selectionMin - 1)
    : selectionMin;

  for (const tokenRange of tokenRanges) {
    if (point >= tokenRange.blockStart && point < tokenRange.blockEnd) {
      return {
        start: tokenRange.blockStart,
        end: tokenRange.blockEnd,
      };
    }
  }

  return null;
}

export function removeTextRange(
  text: string,
  range: TextRange
): { nextText: string; nextCursor: number } {
  const safeStart = clamp(Math.min(range.start, range.end), 0, text.length);
  const safeEnd = clamp(Math.max(range.start, range.end), 0, text.length);
  const before = text.slice(0, safeStart);
  const after = text.slice(safeEnd);

  if (before.endsWith(' ') && after.startsWith(' ')) {
    return {
      nextText: `${before}${after.slice(1)}`,
      nextCursor: safeStart,
    };
  }

  return {
    nextText: `${before}${after}`,
    nextCursor: safeStart,
  };
}
