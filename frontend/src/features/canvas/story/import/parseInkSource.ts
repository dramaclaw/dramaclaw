import type { ImportedKnot, ImportedLink, ImportedStory } from './importTypes';

/**
 * 解析 `.ink` 源(FMV 子集)成导入 IR。按行扫描的状态机:
 * - 顶部 `VAR name = N` → 变量;首个顶层 `-> knot` → 起点。
 * - `=== name ===` → 开新 knot。
 * - knot 内首个文本行 → narration;`# video:` → videoHint;`# ending:`/`-> END` → isEnding。
 * - `+ [text]` / `* [text]` → choice;其后 `~ var += n` → effects;`-> target` → 该 choice 的目标。
 * - 独立 `-> target`(非 END)→ divert。
 * - `{ - cond: -> x ... }` 条件块 → 每个 `-> x` 一条 autoConditional(needsReview=true)。
 */
export function parseInkSource(text: string): ImportedStory {
  const variables: { name: string; initial: number }[] = [];
  const knots: ImportedKnot[] = [];
  const warnings: string[] = [];
  let startKnot = '';

  let current: ImportedKnot | null = null;
  let pendingChoice: ImportedLink | null = null;
  let inConditionBlock = false;
  let blockCondition: string | undefined;
  // # default: N 出现在 narration 行,但选项在其后才解析 —— 暂存 1-based 序号,解析完再落位。
  const pendingDefault = new Map<ImportedKnot, number>();

  const lines = text.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;

    // 变量声明(可在任意处,通常顶部)
    const varMatch = line.match(/^VAR\s+(\w+)\s*=\s*(-?\d+)/);
    if (varMatch) {
      variables.push({ name: varMatch[1], initial: Number(varMatch[2]) });
      continue;
    }

    // knot 头
    const knotMatch = line.match(/^={2,}\s*(\w+)\s*={0,}\s*$/);
    if (knotMatch) {
      current = {
        name: knotMatch[1],
        narration: '',
        tags: [],
        isEnding: false,
        outgoing: [],
        warnings: [],
      };
      knots.push(current);
      pendingChoice = null;
      inConditionBlock = false;
      blockCondition = undefined;
      continue;
    }

    // 条件块
    if (line === '{') {
      inConditionBlock = true;
      blockCondition = undefined;
      continue;
    }
    if (inConditionBlock) {
      if (line === '}') {
        inConditionBlock = false;
        blockCondition = undefined;
        continue;
      }
      // `- cond:` 分支条件
      const condMatch = line.match(/^-\s*(.+?):\s*$/);
      if (condMatch) {
        const cond = condMatch[1].trim();
        blockCondition = cond === 'else' ? undefined : cond;
        continue;
      }
      // 块内的 `-> target` → autoConditional
      const divertMatch = line.match(/^->\s*(\w+)/);
      if (divertMatch && current) {
        const target = divertMatch[1];
        current.outgoing.push({
          kind: 'autoConditional',
          target,
          effects: [],
          condition: blockCondition,
          needsReview: true,
          reviewNote: blockCondition ?? '条件分支(else/自动)',
        });
        blockCondition = undefined;
      }
      continue;
    }

    // 单行内联条件跳转:`{ cond: -> target }` 或 if/else `{ cond: -> a | -> b }`。
    // (多行 `{` 块由上面的 inConditionBlock 处理;这里只接同一行闭合且含 `->` 的。)
    if (current) {
      const inlineCond = line.match(/^\{\s*(.+?)\s*:\s*(.+?)\s*\}$/);
      if (inlineCond && inlineCond[2].includes('->')) {
        const cond = inlineCond[1].trim();
        let first = true;
        for (const branch of inlineCond[2].split('|')) {
          const dm = branch.match(/->\s*(\w+)/);
          if (!dm) continue;
          current.outgoing.push({
            kind: 'autoConditional',
            target: dm[1],
            effects: [],
            condition: first ? cond : undefined, // 第一支用条件,后续支为 else
            needsReview: true,
            reviewNote: first ? cond : '条件分支(else)',
          });
          first = false;
        }
        continue;
      }
    }

    // 顶层起点(在任何 knot 之前)
    if (!current) {
      const startMatch = line.match(/^->\s*(\w+)/);
      if (startMatch) startKnot = startMatch[1];
      continue;
    }

    // 选项
    const choiceMatch = line.match(/^[*+]\s*(.*)$/);
    if (choiceMatch) {
      const rest = choiceMatch[1].trim();
      const bracket = rest.match(/\[(.*?)\]/);
      const choiceText = (bracket ? bracket[1] : rest).trim();
      const link: ImportedLink = {
        kind: 'choice',
        text: choiceText,
        target: '',
        effects: [],
        needsReview: false,
      };
      current.outgoing.push(link);
      pendingChoice = link;
      continue;
    }

    // 效果 `~ var += n` / `~ var -= n`
    const effectMatch = line.match(/^~\s*(\w+)\s*([+-])=\s*(-?\d+)/);
    if (effectMatch) {
      const delta = (effectMatch[2] === '-' ? -1 : 1) * Number(effectMatch[3]);
      const effect = { var: effectMatch[1], delta };
      if (pendingChoice) pendingChoice.effects.push(effect);
      continue;
    }

    // 跳转 / 结局
    const divertMatch = line.match(/^->\s*(\w+)/);
    if (divertMatch) {
      const target = divertMatch[1];
      if (target === 'END' || target === 'DONE') {
        current.isEnding = true;
        pendingChoice = null;
        continue;
      }
      if (pendingChoice && pendingChoice.target === '') {
        pendingChoice.target = target;
        pendingChoice = null;
      } else {
        current.outgoing.push({ kind: 'divert', target, effects: [], needsReview: false });
      }
      continue;
    }

    // 否则:文本行(narration + 行内 tag)
    const segments = line.split('#');
    const textPart = segments[0].trim();
    if (textPart) {
      current.narration = current.narration ? `${current.narration} ${textPart}` : textPart;
    }
    for (let i = 1; i < segments.length; i++) {
      const tag = segments[i].trim();
      if (!tag) continue;
      const video = tag.match(/^video:\s*(.+)$/);
      if (video) {
        current.videoHint = video[1].trim();
        continue;
      }
      // 限时元数据:choiceTime 优先于 timeout;default 暂存待选项解析后落位。
      const choiceTime = tag.match(/^choiceTime:\s*(\d+)/);
      if (choiceTime) {
        current.choiceTimeLimitSec = Number(choiceTime[1]);
        continue;
      }
      const timeout = tag.match(/^timeout:\s*(\d+)/);
      if (timeout) {
        if (current.choiceTimeLimitSec === undefined) {
          current.choiceTimeLimitSec = Number(timeout[1]);
        }
        continue;
      }
      const defaultTag = tag.match(/^default:\s*(\d+)/);
      if (defaultTag) {
        pendingDefault.set(current, Number(defaultTag[1]));
        continue;
      }
      const ending = tag.match(/^ending:\s*(.+)$/);
      if (ending) {
        current.isEnding = true;
        current.endingLabel = ending[1].trim();
      }
      current.tags.push(tag);
    }
  }

  if (!startKnot && knots.length) startKnot = knots[0].name;

  // 落位默认选项:# default: N(1-based)→ 第 N 条出向选项 isDefault。出界则忽略 + warning。
  for (const [knot, n] of pendingDefault) {
    const link = knot.outgoing[n - 1];
    if (link) link.isDefault = true;
    else warnings.push(`${knot.name}: # default ${n} 超出选项数,已忽略`);
  }

  return { variables, startKnot, knots, warnings };
}
