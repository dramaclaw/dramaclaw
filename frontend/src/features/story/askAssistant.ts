// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 把「当前产物 + 该步骤该受的约束」拼成一段交给虾导的提问。
 *
 * 这个文件是故事圣经真正发挥作用的地方。圣经本身只是存着的 JSON，
 * 只有在每次求助时被重新注入，约束才会持续生效——模型不会记得三十轮之前
 * 说过的「绝不恋爱脑」。
 *
 * 三个注入层级（和文档里的设计一一对应）：
 *   全局锁 / 禁止清单 —— 每一步都注入
 *   角色锁           —— 只在角色体系这一步注入（它是输入而不是输出）
 *   结构锁           —— 只在分集目录这一步注入
 *   局部条款         —— 只在写具体某一集时注入
 */
import type { StoryBible } from './storySteps';

// i18n-exempt-start —— 以下是**提示词内容**而不是界面文案。
// 提示词的语言应当跟着剧本走，而不是跟着界面语言走：用户在英文界面下写中文剧本时，
// 把约束翻译成英文只会让模型的产出跟着漂移。同 superchat-panel 里既有提示词的处理方式。
const SECTION_TITLES = {
  locks: '【全局锁 · 以下规则在本剧任何一集都不得违反】',
  blacklist: '【禁止清单 · 命中任意一条即为不合格】',
  castLock: '【角色锁 · 这些角色与绑定关系是定好的，按此生成，不要另起炉灶】',
  structureLock: '【结构锁 · 分集顺序必须遵循这条时间线】',
  stageNotes: '【本阶段额外要求】',
  localOverride: '【本集额外要求】',
  current: '【当前内容】',
  empty: '（当前还是空的）',
} as const;

const STEP_TASKS: Record<string, string> = {
  bible: '请帮我把上面的创作约束补全、去重，并指出彼此冲突的条款。',
  plan: '请按上述约束打磨这份创作方案：三幕结构、节奏曲线、付费卡点、爽点分布。',
  characters: '请按上述约束打磨角色体系：主要角色档案、关系、弧线、四层反派。角色锁里已有的必须保留。',
  outline: '请按上述约束打磨分集目录，每集一行，标出关键集与付费卡点集。结构锁里已有的阶段必须保留且顺序不变。',
  episodes: '请按上述约束打磨这一集的剧本。保持交接格式：场次行写成「序号 地点 日/夜 内/外」，其后紧跟「人物：」行。',
};

const FORMAT_REMINDER =
  '输出正文时请直接给出可用文本，不要加代码块包裹，也不要额外解释格式。';
// i18n-exempt-end

function bulletList(items: readonly string[]): string {
  return items.filter(Boolean).map((item) => `- ${item}`).join('\n');
}

function renderLocks(bible: StoryBible): string {
  const lines = [
    bible.locks.positioning,
    bible.locks.era,
    bible.locks.dialogueStyle,
    ...bible.locks.toneRules,
  ].filter((value) => value && value.trim());
  return lines.length ? `${SECTION_TITLES.locks}\n${bulletList(lines)}` : '';
}

function renderBlacklist(bible: StoryBible): string {
  return bible.blacklist.length
    ? `${SECTION_TITLES.blacklist}\n${bulletList(bible.blacklist)}`
    : '';
}

function renderCastLock(bible: StoryBible): string {
  if (!bible.castLock.length) return '';
  const lines = bible.castLock.map((entry) => {
    const parts = [entry.name, entry.bind, entry.arc].filter(Boolean).join(' · ');
    const scenes = (entry.mustHave ?? []).filter(Boolean);
    // i18n-exempt-start —— 拼进提示词的连接词，与 SECTION_TITLES 同属提示词内容。
    return scenes.length ? `${parts}｜必须有：${scenes.join('、')}` : parts;
    // i18n-exempt-end
  });
  return `${SECTION_TITLES.castLock}\n${bulletList(lines)}`;
}

function renderStructureLock(bible: StoryBible): string {
  if (!bible.structureLock.length) return '';
  const lines = bible.structureLock.map((entry, index) =>
    [`${index + 1}. ${entry.stage}`, entry.plot, entry.bind, entry.tone, entry.notes]
      .filter(Boolean)
      .join('｜'),
  );
  return `${SECTION_TITLES.structureLock}\n${lines.join('\n')}`;
}

export function episodeOverrideKey(episodeNumber: number): string {
  return `ep${String(episodeNumber).padStart(3, '0')}`;
}

/**
 * 组装交给虾导的提问。
 *
 * `stepId` 决定注入哪些约束——不是全都塞进去。角色锁对分集目录没有指导意义，
 * 结构锁对单集正文也一样；无关约束只会稀释真正该被遵守的那几条。
 */
export function buildStoryPrompt(options: {
  stepId: string;
  bible: StoryBible;
  content: string;
  episodeNumber?: number;
  /** 这一集属于哪个阶段；用来把阶段级条款投给正确的集。 */
  episodeStage?: string;
}): string {
  const { stepId, bible, content, episodeNumber, episodeStage } = options;
  const blocks: string[] = [];

  const locks = renderLocks(bible);
  if (locks) blocks.push(locks);
  const blacklist = renderBlacklist(bible);
  if (blacklist) blocks.push(blacklist);

  if (stepId === 'characters') {
    const cast = renderCastLock(bible);
    if (cast) blocks.push(cast);
  }
  if (stepId === 'outline') {
    const structure = renderStructureLock(bible);
    if (structure) blocks.push(structure);
  }
  if (stepId === 'episodes') {
    // 阶段级条款：跟着阶段走，分集怎么重排都不会错位。
    const stage = bible.structureLock.find((entry) => entry.stage && entry.stage === episodeStage);
    if (stage) {
      const stageLine = [stage.plot, stage.bind, stage.tone].filter(Boolean).join('｜');
      const detail = [stageLine, stage.notes?.trim()].filter(Boolean).join('\n');
      if (detail) blocks.push(`${SECTION_TITLES.stageNotes}\n${stage.stage}｜${detail}`);
    }
    // 遗留的按集号条款：还在就照旧注入，不让早先填过的内容变成孤儿。
    if (episodeNumber != null) {
      const override = bible.localOverrides?.[episodeOverrideKey(episodeNumber)];
      if (override && override.trim()) {
        blocks.push(`${SECTION_TITLES.localOverride}\n${override.trim()}`);
      }
    }
  }

  const trimmed = (content ?? '').trim();
  blocks.push(`${SECTION_TITLES.current}\n${trimmed || SECTION_TITLES.empty}`);
  blocks.push(STEP_TASKS[stepId] ?? STEP_TASKS.plan);
  if (stepId === 'episodes') blocks.push(FORMAT_REMINDER);

  return blocks.join('\n\n');
}
