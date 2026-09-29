// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 片段重拍 / 智能续写共用的区间模型：校验、增删改、提示词与结构化载荷。
 *
 * ## 为什么是提示词，而不是剪辑
 *
 * 反编译 LibTV 之后确认：这两个功能都是**模型原生能力**，前端只负责把时间区间
 * 写成模型读得懂的话，一帧都没剪。我们目录里的 `seedance-2.5` 声明了同样的
 * `video_edit` 模式和同一批约束（minDuration 4 / maxDuration 30 /
 * referenceVideoMinSeconds 2），所以走同一条路。
 *
 * ## 为什么内部用厘秒整数
 *
 * 区间的每一条规则都是「比较」——够不够 4 秒、两段有没有挨上、剩下的碎片能不能
 * 独立成段。用浮点秒做这些比较，`0.1 + 0.2 !== 0.3` 迟早会让一个拖到刚好合法的
 * 区间在提交时被拒，而用户看到的两个数字明明是对的。所以进来先乘 100 取整，
 * 所有判断在整数域做完，出去再除回去。0.01 秒的精度对一段 4 秒起步的视频足够。
 *
 * ## 为什么校验有两层
 *
 * [[validateRemakeRanges]] 面向用户：一次把所有问题都列出来，界面好逐条提示。
 * [[prepareRemakeRangesForSubmission]] 面向提交：只要有一段不合法就**整体不提交**，
 * 并回报是哪几段。不做「把能提交的提交掉」——那会产出一个用户没预期的视频，
 * 而且还得再花一次钱。这一条是照 LibTV 的实现抄的，他们同样是全有或全无。
 */

/** 最多能选几段重拍。超过这个数，提示词本身就开始互相稀释了。 */
export const SEGMENT_REMAKE_MAX_RANGES = 5;
/** 源视频短于这个时长不允许重拍——模型的最小输入就是 4 秒。 */
export const SEGMENT_REMAKE_MIN_SOURCE_SEC = 4;
/** 单段时长下限，与模型的最小生成时长同源。 */
export const SEGMENT_REMAKE_MIN_RANGE_SEC = 4;
/** 单段时长上限，与模型的最大生成时长同源。 */
export const SEGMENT_REMAKE_MAX_RANGE_SEC = 30;
/** 两段之间留下的空隙也得够模型生成一段，否则中间那截无法成立。 */
export const SEGMENT_REMAKE_MIN_GAP_SEC = 4.1;
/**
 * 拖拽边界时的段长下限，比提交校验的 4 秒多留 0.1 秒。
 *
 * 少了这 0.1 秒，用户把边界拖到「刚好 4 秒」时，指针位置换算出的秒数落在 3.995
 * 还是 4.005 完全看像素，拖出来显示 4.0s 却提交失败。LibTV 同样在这里留了余量。
 */
export const SEGMENT_REMAKE_RESIZE_MIN_RANGE_SEC = 4.1;
/** 新插入一段的默认时长；空隙比它短时就用整个空隙。 */
export const SEGMENT_REMAKE_DEFAULT_RANGE_SEC = 5;

export const CONTINUATION_MIN_SEC = 4;
export const CONTINUATION_MAX_SEC = 30;

const CS = 100;
const MIN_SOURCE_CS = SEGMENT_REMAKE_MIN_SOURCE_SEC * CS;
const MIN_RANGE_CS = SEGMENT_REMAKE_MIN_RANGE_SEC * CS;
const MAX_RANGE_CS = SEGMENT_REMAKE_MAX_RANGE_SEC * CS;
const MIN_GAP_CS = Math.round(SEGMENT_REMAKE_MIN_GAP_SEC * CS);

/** 秒 → 厘秒整数。非有限数返回 null，由调用方决定怎么处理，不静默当 0。 */
function toCs(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * CS) : null;
}

function fromCs(value: number): number {
  return value / CS;
}

function clampCs(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface TimeRange {
  id: string;
  startSec: number;
  endSec: number;
  /** 这一段要怎么改；整段模式下留空表示「原样重跑一次」。 */
  intent?: string;
}

export type RangeRejection =
  | { code: 'source_too_short'; minSec: number }
  | { code: 'too_many_ranges'; max: number }
  | { code: 'range_out_of_bounds' }
  | { code: 'range_too_short'; minSec: number }
  | { code: 'range_too_long'; maxSec: number }
  | { code: 'ranges_overlap' }
  | { code: 'gap_too_short'; minSec: number };

export interface RangeValidation {
  ok: boolean;
  /** 全部问题，不是第一个——一次说清楚，别让用户改一个再撞一个。 */
  rejections: RangeRejection[];
  /** 按时间排好序的区间，调用方直接用这一份。 */
  sorted: TimeRange[];
}

export function sortRanges(ranges: readonly TimeRange[]): TimeRange[] {
  return [...ranges].sort((a, b) => a.startSec - b.startSec);
}

export function isRemakeSourceDurationSupported(sourceDurationSec: number): boolean {
  const cs = toCs(sourceDurationSec);
  return cs !== null && cs >= MIN_SOURCE_CS;
}

export function validateRemakeRanges(input: {
  ranges: readonly TimeRange[];
  sourceDurationSec: number;
}): RangeValidation {
  const rejections: RangeRejection[] = [];
  const sorted = sortRanges(input.ranges);
  const sourceCs = toCs(input.sourceDurationSec) ?? 0;

  if (sourceCs < MIN_SOURCE_CS) {
    rejections.push({ code: 'source_too_short', minSec: SEGMENT_REMAKE_MIN_SOURCE_SEC });
  }
  if (sorted.length > SEGMENT_REMAKE_MAX_RANGES) {
    rejections.push({ code: 'too_many_ranges', max: SEGMENT_REMAKE_MAX_RANGES });
  }

  let sawOutOfBounds = false;
  let sawTooShort = false;
  let sawTooLong = false;
  for (const range of sorted) {
    const start = toCs(range.startSec);
    const end = toCs(range.endSec);
    if (start === null || end === null || start < 0 || end > sourceCs || end <= start) {
      sawOutOfBounds = true;
      continue;
    }
    const span = end - start;
    if (span < MIN_RANGE_CS) sawTooShort = true;
    if (span > MAX_RANGE_CS) sawTooLong = true;
  }
  if (sawOutOfBounds) rejections.push({ code: 'range_out_of_bounds' });
  if (sawTooShort) {
    rejections.push({ code: 'range_too_short', minSec: SEGMENT_REMAKE_MIN_RANGE_SEC });
  }
  if (sawTooLong) {
    rejections.push({ code: 'range_too_long', maxSec: SEGMENT_REMAKE_MAX_RANGE_SEC });
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previousEnd = toCs(sorted[index - 1].endSec);
    const currentStart = toCs(sorted[index].startSec);
    if (previousEnd !== null && currentStart !== null && currentStart < previousEnd) {
      rejections.push({ code: 'ranges_overlap' });
      break;
    }
  }

  // 空隙检查：段与段之间、以及首尾到片头片尾，剩下的每一截都得够长。
  // 不检查的话会切出一个 0.5 秒的残片，那截既不能重拍也接不回去。
  if (
    gapsCs(sorted, sourceCs).some((gap) => {
      const span = gap.end - gap.start;
      return span > 0 && span < MIN_GAP_CS;
    })
  ) {
    rejections.push({ code: 'gap_too_short', minSec: SEGMENT_REMAKE_MIN_GAP_SEC });
  }

  return { ok: rejections.length === 0, rejections, sorted };
}

interface GapCs {
  start: number;
  end: number;
}

function gapsCs(sorted: readonly TimeRange[], sourceCs: number): GapCs[] {
  const gaps: GapCs[] = [];
  let cursor = 0;
  for (const range of sorted) {
    const start = toCs(range.startSec);
    const end = toCs(range.endSec);
    if (start === null || end === null) continue;
    if (start > cursor) gaps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (sourceCs > cursor) gaps.push({ start: cursor, end: sourceCs });
  return gaps;
}

/** 当前还空着的时间段（秒）。界面用它画「可以在这里加一段」的可点区域。 */
export function getRemakeGaps(
  ranges: readonly TimeRange[],
  sourceDurationSec: number,
): { startSec: number; endSec: number }[] {
  const sourceCs = toCs(sourceDurationSec) ?? 0;
  return gapsCs(sortRanges(ranges), sourceCs).map((gap) => ({
    startSec: fromCs(gap.start),
    endSec: fromCs(gap.end),
  }));
}

/** 其中放得下一段的那些空隙。放不下的空隙点了也没用，不该给用户点。 */
export function getInsertableRemakeGaps(
  ranges: readonly TimeRange[],
  sourceDurationSec: number,
): { startSec: number; endSec: number }[] {
  const sourceCs = toCs(sourceDurationSec) ?? 0;
  return gapsCs(sortRanges(ranges), sourceCs)
    .filter((gap) => gap.end - gap.start >= MIN_RANGE_CS)
    .map((gap) => ({ startSec: fromCs(gap.start), endSec: fromCs(gap.end) }));
}

/**
 * 在点击处插入一段。
 *
 * 落位规则里唯一需要解释的一条：**当放完这一段、空隙里剩下的碎片短到接不回去时，
 * 直接把整个空隙吃掉**。否则用户在一个 6 秒的空隙里点一下，会得到一段 4 秒的重拍
 * 外加两截 1 秒的废料，然后被校验拦下——这种「点一下就错」的交互不该存在。
 */
export function insertRemakeRange(input: {
  ranges: readonly TimeRange[];
  atSec: number;
  sourceDurationSec: number;
  id: string;
  desiredSec?: number;
}): TimeRange[] {
  const sorted = sortRanges(input.ranges);
  if (sorted.length >= SEGMENT_REMAKE_MAX_RANGES) return sorted;

  const sourceCs = toCs(input.sourceDurationSec) ?? 0;
  const atCs = toCs(input.atSec);
  if (sourceCs < MIN_SOURCE_CS || atCs === null) return sorted;

  const gap = gapsCs(sorted, sourceCs).find(
    (candidate) => atCs >= candidate.start && atCs <= candidate.end,
  );
  if (!gap) return sorted;

  const span = gap.end - gap.start;
  if (span < MIN_RANGE_CS) return sorted;

  const desiredCs = toCs(input.desiredSec ?? SEGMENT_REMAKE_DEFAULT_RANGE_SEC) ?? MIN_RANGE_CS;
  let length = Math.min(Math.max(desiredCs, MIN_RANGE_CS), span, MAX_RANGE_CS);
  if (span <= MAX_RANGE_CS && span - length < MIN_GAP_CS) length = span;

  let start = clampCs(atCs - Math.round(length / 2), gap.start, gap.end - length);
  // 贴边：头/尾剩下的碎片短到接不回去时，把这一段推到空隙边上，把碎片让给另一头。
  if (start - gap.start < MIN_GAP_CS) start = gap.start;
  if (gap.end - (start + length) < MIN_GAP_CS) start = Math.max(gap.start, gap.end - length);

  return sortRanges([
    ...sorted,
    { id: input.id, startSec: fromCs(start), endSec: fromCs(start + length), intent: '' },
  ]);
}

/**
 * 拖动某一段的一个边界。
 *
 * 边界只在「相邻段 / 片头片尾」和「段长 4.1–30 秒」两组约束里滑动，拖不动就原样返回。
 * 不在这里检查空隙——空隙是放手之后由校验层统一说的，拖动过程中不断弹错更烦人。
 */
export function resizeRemakeRange(input: {
  ranges: readonly TimeRange[];
  id: string;
  edge: 'start' | 'end';
  valueSec: number;
  sourceDurationSec: number;
}): TimeRange[] {
  const sorted = sortRanges(input.ranges);
  const index = sorted.findIndex((range) => range.id === input.id);
  if (index < 0) return sorted;

  const sourceCs = toCs(input.sourceDurationSec) ?? 0;
  const target = sorted[index];
  const startCs = toCs(target.startSec);
  const endCs = toCs(target.endSec);
  const valueCs = toCs(input.valueSec);
  if (startCs === null || endCs === null || valueCs === null) return sorted;

  const floorCs = index > 0 ? toCs(sorted[index - 1].endSec) ?? 0 : 0;
  const ceilCs = index < sorted.length - 1 ? toCs(sorted[index + 1].startSec) ?? sourceCs : sourceCs;
  const minRange = Math.round(SEGMENT_REMAKE_RESIZE_MIN_RANGE_SEC * CS);

  const bounds =
    input.edge === 'start'
      ? { min: Math.max(floorCs, endCs - MAX_RANGE_CS), max: endCs - minRange }
      : { min: startCs + minRange, max: Math.min(ceilCs, startCs + MAX_RANGE_CS) };
  if (bounds.max < bounds.min) return sorted;

  const next = clampCs(valueCs, bounds.min, bounds.max);
  const resized: TimeRange =
    input.edge === 'start'
      ? { ...target, startSec: fromCs(next) }
      : { ...target, endSec: fromCs(next) };
  return sortRanges(sorted.map((range) => (range.id === input.id ? resized : range)));
}

export interface PreparedRemakeRanges {
  sourceDurationSec: number;
  /** 全部合法时是规整过的区间；只要有一段不合法就是空数组。 */
  ranges: TimeRange[];
  /** 不合法的段 id。界面据此把那几段标红，而不是给一句笼统的失败。 */
  failedRangeIds: string[];
}

/**
 * 提交前的规整与门禁。
 *
 * 末段越界时先截到源时长再看够不够长，够不着就把 start 往前挪——用户拖到片尾时
 * 多出的那几毫秒是像素误差，不该让他重拖一次。挪不动才判失败。
 */
export function prepareRemakeRangesForSubmission(input: {
  ranges: readonly TimeRange[];
  sourceDurationSec: number;
}): PreparedRemakeRanges {
  const sourceCs = toCs(input.sourceDurationSec) ?? 0;
  const sourceDurationSec = fromCs(sourceCs);
  const sorted = sortRanges(input.ranges);
  if (sorted.length === 0) return { sourceDurationSec, ranges: [], failedRangeIds: [] };

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const range of sorted) {
    if (seen.has(range.id)) duplicates.add(range.id);
    seen.add(range.id);
  }
  if (duplicates.size > 0) {
    return { sourceDurationSec, ranges: [], failedRangeIds: [...duplicates] };
  }
  if (sourceCs < MIN_SOURCE_CS || sorted.length > SEGMENT_REMAKE_MAX_RANGES) {
    return { sourceDurationSec, ranges: [], failedRangeIds: sorted.map((range) => range.id) };
  }

  const failed = new Set<string>();
  const prepared: TimeRange[] = [];
  let previousEnd: number | null = null;

  for (const range of sorted) {
    let start = toCs(range.startSec);
    let end = toCs(range.endSec);
    if (start === null || end === null) {
      failed.add(range.id);
      continue;
    }
    if (end > sourceCs) {
      end = sourceCs;
      if (end - start < MIN_RANGE_CS) {
        const pulled = end - MIN_RANGE_CS;
        if (pulled >= 0 && (previousEnd === null || pulled >= previousEnd)) start = pulled;
      }
    }
    const span = end - start;
    if (
      start < 0
      || end > sourceCs
      || span < MIN_RANGE_CS
      || span > MAX_RANGE_CS
      || (previousEnd !== null && start < previousEnd)
    ) {
      failed.add(range.id);
    }
    previousEnd = end;
    prepared.push({ ...range, startSec: fromCs(start), endSec: fromCs(end) });
  }

  if (failed.size > 0) {
    return { sourceDurationSec, ranges: [], failedRangeIds: [...failed] };
  }
  return { sourceDurationSec, ranges: prepared, failedRangeIds: [] };
}

export interface EditSegment {
  timeRange: { start: number; end: number };
  durationSec: number;
  prompt: string;
}

/**
 * 结构化那一份。
 *
 * LibTV 是提示词和 `editSegments` 两份**同时**发的，不是二选一。我们这边暂时只有
 * 提示词那份真正生效：`model_params` 走目录 schema 严格校验，没在目录里声明的 key
 * 会被直接拒掉。所以这份先备着，等某个模型的目录条目声明了 `editSegments`
 * 再接上去——那时候不用改这里。
 */
export function buildEditSegments(ranges: readonly TimeRange[]): EditSegment[] {
  return sortRanges(ranges).map((range) => {
    const start = toCs(range.startSec) ?? 0;
    const end = toCs(range.endSec) ?? start;
    return {
      timeRange: { start: fromCs(start), end: fromCs(end) },
      durationSec: fromCs(Math.max(0, end - start)),
      prompt: (range.intent ?? '').trim(),
    };
  });
}

/** `3.0s` / `12.5s` —— 段上的时长角标。 */
export function formatRangeDurationLabel(range: TimeRange): string {
  const start = toCs(range.startSec) ?? 0;
  const end = toCs(range.endSec) ?? start;
  return `${fromCs(Math.max(0, end - start)).toFixed(1)}s`;
}

/**
 * 提示词那一份。
 *
 * `mediaToken` 由调用方给：这个模块不知道源视频在参考列表里排第几，也不该知道。
 * 视频编辑模式下源视频是独立字段、不进编号引用列表，所以调用方传的是
 * 「这段视频」这样的自然语言指代，而不是 `@视频1` —— 后端按编号解析引用，
 * 指一个不在列表里的编号只会解析失败。
 */
export function buildRemakePrompt(input: {
  ranges: readonly TimeRange[];
  mediaToken: string;
  /** 整段模式下的说明；留空表示原样重跑一次。 */
  wholeIntent?: string;
}): string {
  const sorted = sortRanges(input.ranges);
  if (sorted.length === 0) {
    const intent = (input.wholeIntent ?? '').trim();
    return intent ? `将 ${input.mediaToken}：${intent}` : input.mediaToken; // i18n-exempt: model prompt protocol
  }
  return sorted
    .map((range) => {
      const intent = (range.intent ?? '').trim();
      const start = fromCs(toCs(range.startSec) ?? 0);
      const end = fromCs(toCs(range.endSec) ?? 0);
      const head = `将 ${input.mediaToken} 的第 ${start} 秒到第 ${end} 秒`; // i18n-exempt: model prompt protocol
      return intent ? `${head}：${intent}` : `${head}：重拍这一段`; // i18n-exempt: model prompt protocol
    })
    .join('\n');
}

export interface ContinuationSelection {
  startSec: number;
  endSec: number;
}

/** 续写的默认选区：从头取，最多 30 秒。 */
export function initialContinuationRange(
  sourceDurationSec: number,
): ContinuationSelection | null {
  if (sourceDurationSec < CONTINUATION_MIN_SEC) return null;
  return { startSec: 0, endSec: Math.min(sourceDurationSec, CONTINUATION_MAX_SEC) };
}

export function isContinuationRangeSupported(range: ContinuationSelection): boolean {
  const duration = range.endSec - range.startSec;
  return (
    range.startSec >= 0 &&
    duration >= CONTINUATION_MIN_SEC &&
    duration <= CONTINUATION_MAX_SEC
  );
}

export function buildContinuationPrompt(input: {
  mediaToken: string;
  intent?: string;
}): string {
  const intent = (input.intent ?? '').trim();
  const head = `对 ${input.mediaToken} 进行续写`; // i18n-exempt: model prompt protocol
  return intent ? `${head}：${intent}` : `${head}`;
}

/**
 * 续写绑定：目标节点记着自己续的是谁的哪一段。
 *
 * 只存 id 和区间，不存快照——源节点被替换、边被删掉、区间被改动之后，这份绑定
 * 必须失效并要求重选。不校验就会拿着一个已经不存在的区间去提交。
 */
export interface ContinuationBinding {
  sourceNodeId: string;
  sourceEdgeId: string;
  range: ContinuationSelection;
  /** 源视频地址，用于识别「源没删但内容换了」。 */
  sourceVideoUrl: string;
}

export function isContinuationBindingValid(input: {
  binding: ContinuationBinding;
  targetNodeId: string;
  edges: readonly { id: string; source: string; target: string }[];
  currentSourceVideoUrl: string | null;
}): boolean {
  const edgeAlive = input.edges.some(
    (edge) =>
      edge.id === input.binding.sourceEdgeId &&
      edge.source === input.binding.sourceNodeId &&
      edge.target === input.targetNodeId,
  );
  return (
    edgeAlive &&
    input.currentSourceVideoUrl === input.binding.sourceVideoUrl &&
    isContinuationRangeSupported(input.binding.range)
  );
}
