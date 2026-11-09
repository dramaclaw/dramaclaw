/**
 * 互动影游试玩统计:在播放器内埋点「选择分布」与「结局达成率」,localStorage 本地聚合。
 * 面向创作者试玩期验证故事——哪些选项没人选、哪个结局最难达成——先本地统计,后续可选上报。
 *
 * 与 {@link ./storySave} 同款容错:所有读写吞异常 → 隐私模式/配额超限时优雅降级为「不统计」。
 * key 用 `st.story.stats.` 前缀,与存档同受 reset-region-state 的 SWEEP_PREFIXES(`st.story.`)覆盖。
 */

/** 单个选项的累计:文案(冗余存,便于面板无需重编译即可渲染)+ 被选次数。 */
export interface StoryStatsOption {
  text: string;
  count: number;
}

/** 单个选择点(源节点)的分布:可选标签 + 各选项(按 inkjs choice index 的字符串键)。 */
export interface StoryStatsPoint {
  label?: string;
  options: Record<string, StoryStatsOption>;
}

/** 单个结局的达成累计。 */
export interface StoryStatsEnding {
  title: string;
  label?: string;
  count: number;
}

export interface StoryStats {
  /** 完整通关(到达任一结局)的总次数,用作结局达成率的分母。 */
  totalRuns: number;
  /** 选择点 nodeId → 该点各选项的选择分布。 */
  points: Record<string, StoryStatsPoint>;
  /** 结局 nodeId → 达成累计。 */
  endings: Record<string, StoryStatsEnding>;
}

export function emptyStoryStats(): StoryStats {
  return { totalRuns: 0, points: {}, endings: {} };
}

/** 存档 key → 统计 key(把 `.save.` 段换成 `.stats.`);无存档 key(不持久化)则无统计。 */
export function statsKeyFromSaveKey(saveKey: string | null): string | null {
  return saveKey ? saveKey.replace('.save.', '.stats.') : null;
}

export function readStoryStats(key: string): StoryStats {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return emptyStoryStats();
    const parsed = JSON.parse(raw) as Partial<StoryStats> | null;
    // 结构性兜底:任一字段缺失/类型不符都回退到空,避免脏数据让面板炸掉。
    if (!parsed || typeof parsed !== 'object') return emptyStoryStats();
    return {
      totalRuns: typeof parsed.totalRuns === 'number' ? parsed.totalRuns : 0,
      points: parsed.points && typeof parsed.points === 'object' ? parsed.points : {},
      endings: parsed.endings && typeof parsed.endings === 'object' ? parsed.endings : {},
    };
  } catch {
    return emptyStoryStats();
  }
}

function write(key: string, stats: StoryStats): void {
  try {
    localStorage.setItem(key, JSON.stringify(stats));
  } catch {
    // 隐私模式 / 配额超限:静默降级为不统计。
  }
}

/** 记录一次选择:在源节点 nodeId 选了 inkjs index 对应的选项。 */
export function recordChoice(
  key: string,
  { nodeId, index, text, pointLabel }: { nodeId: string; index: number; text: string; pointLabel?: string },
): void {
  const stats = readStoryStats(key);
  const point = stats.points[nodeId] ?? { options: {} };
  if (pointLabel) point.label = pointLabel;
  const opt = point.options[index] ?? { text, count: 0 };
  opt.text = text; // 文案可能被创作者改过,以最新一次为准
  opt.count += 1;
  point.options[index] = opt;
  stats.points[nodeId] = point;
  write(key, stats);
}

/** 记录一次通关:到达结局 nodeId,同时递增 totalRuns。 */
export function recordEnding(
  key: string,
  { nodeId, title, label }: { nodeId: string; title: string; label?: string },
): void {
  const stats = readStoryStats(key);
  const ending = stats.endings[nodeId] ?? { title, count: 0 };
  ending.title = title;
  if (label) ending.label = label;
  ending.count += 1;
  stats.endings[nodeId] = ending;
  stats.totalRuns += 1;
  write(key, stats);
}

export function clearStoryStats(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上。
  }
}
