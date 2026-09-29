// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 剧本交接格式的前端校验。
 *
 * 契约来自后端 `utils/screenplay_scene_parser.py` + `cognee/script_parser.py`：
 *
 *     第1集
 *     1-1  洛阳·司空府正堂  夜  内
 *     人物：曹操、荀彧
 *     （正文）
 *
 * 为什么前端也要校验一遍：导入那一步的拒绝信息是给「上传别人写好的剧本」设计的，
 * 对创作流程来说来得太晚——几十集写完才被 ingest 打回，代价是整轮返工。这里在
 * 每一集写完时就给出判定，坏掉的是哪一场、缺什么，都能当场指出来。
 *
 * 这份实现**只作提示**，最终仍以后端 `assess_screenplay_scene_headers()` 为准；
 * 两边判定不一致时以后端为准，前端不做拦截。
 */

/** 场次行：`1-2地点 日 内`，编号与地点之间可无空格。 */
// i18n-exempt-start —— 以下全部是后端剧本格式的**协议字面量**，不是界面文案。
// 它们必须和 utils/screenplay_scene_parser.py 逐字一致；翻译它们等于改协议。
const SCENE_HEADER_RE = /^(\d+)\s*[-‑]\s*(\d+)\s*(.*)$/;
const EPISODE_HEADER_RE = /^第\s*([0-9一二三四五六七八九十百零]+)\s*集/;
const CHARACTER_LINE_RE = /^人物\s*[：:]/;

const TIME_OF_DAY = ['日', '夜', '晨', '晚', '黄昏', '清晨', '傍晚', '深夜', '午后'];
const INTERIOR_EXTERIOR = ['内', '外'];
// i18n-exempt-end

export type SceneHeaderStatus = 'standard' | 'repairable' | 'missing';

export interface SceneIssue {
  line: number;
  text: string;
  /** i18n key 后缀，页面拼成 `story.compile.issue.<reason>` */
  reason: 'missingTimeOfDay' | 'missingInteriorExterior' | 'missingLocation' | 'missingCharacterLine';
}

export interface ScreenplayAssessment {
  status: SceneHeaderStatus;
  episodeCount: number;
  sceneCount: number;
  /** 完全合规的场次数 */
  standardScenes: number;
  issues: SceneIssue[];
}

/**
 * 判定一份剧本文本是否达标。
 *
 * `missing`   —— 一个场次头都没有，导入会被直接拒
 * `repairable`—— 有场次头但缺时间/内外景，导入会降级处理
 * `standard`  —— 全部达标
 */
export function assessScreenplay(text: string): ScreenplayAssessment {
  const lines = (text ?? '').split(/\r?\n/);
  const issues: SceneIssue[] = [];
  let episodeCount = 0;
  let sceneCount = 0;
  let standardScenes = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    if (EPISODE_HEADER_RE.test(raw)) {
      episodeCount += 1;
      continue;
    }
    const match = SCENE_HEADER_RE.exec(raw);
    if (!match) continue;

    sceneCount += 1;
    const rest = match[3].trim();
    const hasTime = TIME_OF_DAY.some((token) => rest.includes(token));
    const hasInteriorExterior = INTERIOR_EXTERIOR.some((token) => rest.includes(token));
    // 去掉时间与内外景之后还剩下的才算地点。
    let location = rest;
    for (const token of [...TIME_OF_DAY, ...INTERIOR_EXTERIOR]) location = location.split(token).join(' ');
    const hasLocation = location.trim().length > 0;

    if (!hasLocation) issues.push({ line: index + 1, text: raw, reason: 'missingLocation' });
    if (!hasTime) issues.push({ line: index + 1, text: raw, reason: 'missingTimeOfDay' });
    if (!hasInteriorExterior) issues.push({ line: index + 1, text: raw, reason: 'missingInteriorExterior' });

    // `人物：` 行应当紧随其后（允许中间夹空行）。
    let cursor = index + 1;
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    const hasCharacterLine = cursor < lines.length && CHARACTER_LINE_RE.test(lines[cursor].trim());
    if (!hasCharacterLine) {
      issues.push({ line: index + 1, text: raw, reason: 'missingCharacterLine' });
    }

    if (hasLocation && hasTime && hasInteriorExterior && hasCharacterLine) standardScenes += 1;
  }

  const status: SceneHeaderStatus =
    sceneCount === 0 ? 'missing' : standardScenes === sceneCount ? 'standard' : 'repairable';

  return { status, episodeCount, sceneCount, standardScenes, issues };
}

/** 把分集草稿拼成可导入的全文。梗概段落放在第一集之前——后端 `extract_synopsis()` 读的正是那一段。 */
export function compileScreenplay(
  synopsis: string,
  drafts: { number: number; title: string; body: string }[],
): string {
  const chunks: string[] = [];
  const trimmedSynopsis = (synopsis ?? '').trim();
  if (trimmedSynopsis) chunks.push(trimmedSynopsis);
  for (const draft of [...drafts].sort((a, b) => a.number - b.number)) {
    // i18n-exempt-start —— 分集头是 EPISODE_HEADER_RE 要匹配的协议格式，不可翻译。
    const heading = draft.title.trim()
      ? `第${draft.number}集 ${draft.title.trim()}`
      : `第${draft.number}集`;
    // i18n-exempt-end
    chunks.push(`${heading}\n${(draft.body ?? '').trim()}`);
  }
  return chunks.join('\n\n');
}
