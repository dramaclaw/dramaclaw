import type { ImportedKnot, ImportedLink, ImportedStory } from './importTypes';

/** inkjs runtime 值:字符串指令、数字、嵌套容器数组、命令对象。 */
type InkVal = string | number | boolean | null | InkVal[] | { [k: string]: unknown };

const RESERVED_KEYS = new Set(['#f', '#n', 'global decl']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 容器数组的尾随命名映射(含 #f / 子容器 c-N / b),其余为内容。 */
function splitContainer(arr: InkVal[]): { items: InkVal[]; named: Record<string, unknown> | null } {
  const last = arr[arr.length - 1];
  if (isObj(last)) return { items: arr.slice(0, -1), named: last };
  return { items: arr, named: null };
}

/** 真实跳转目标:已知 knot 名且非内部点路径(如 judge.8)。 */
function isRealTarget(target: unknown, knotNames: Set<string>): target is string {
  return typeof target === 'string' && !target.includes('.') && knotNames.has(target);
}

/** RPN(ink ev 序列)→ 中缀条件文本。无法识别返回 undefined。 */
function rpnToInfix(tokens: InkVal[]): string | undefined {
  const stack: string[] = [];
  const binary = new Set(['>=', '<=', '>', '<', '==', '!=', '&&', '||', '+', '-', '*', '/']);
  for (const t of tokens) {
    if (isObj(t) && typeof t['VAR?'] === 'string') {
      stack.push(t['VAR?'] as string);
    } else if (typeof t === 'number') {
      stack.push(String(t));
    } else if (typeof t === 'string' && binary.has(t)) {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return undefined;
      stack.push(`${a} ${t} ${b}`);
    }
    // 其它(ev/str/...)忽略
  }
  return stack.length ? stack[stack.length - 1] : undefined;
}

/** 嵌套数组是否为条件分支结构(尾随映射含 b 子容器)。 */
function isConditional(el: InkVal): el is InkVal[] {
  if (!Array.isArray(el)) return false;
  const last = el[el.length - 1];
  return isObj(last) && 'b' in last;
}

/** 解析选项体(c-N 子容器):提取效果与跳转目标。 */
function parseChoiceBody(body: InkVal[], link: ImportedLink, knotNames: Set<string>): void {
  for (let i = 0; i < body.length; i++) {
    const el = body[i];
    // 效果模式:{"VAR?":v}, n, "+"/"-", {"VAR=":v}
    if (typeof el === 'number' && (body[i + 1] === '+' || body[i + 1] === '-')) {
      const op = body[i + 1];
      const assign = body[i + 2];
      if (isObj(assign) && typeof assign['VAR='] === 'string') {
        const delta = (op === '-' ? -1 : 1) * el;
        link.effects.push({ var: assign['VAR='] as string, delta });
      }
      continue;
    }
    if (isObj(el) && '->' in el && isRealTarget(el['->'], knotNames)) {
      link.target = el['->'] as string;
    }
  }
}

/** 解析条件分支嵌套数组 → 一条 autoConditional link。 */
function parseConditional(el: InkVal[], knot: ImportedKnot, knotNames: Set<string>): void {
  const { items, named } = splitContainer(el);
  // ev ... /ev 之间的条件 RPN
  const evStart = items.indexOf('ev');
  const evEnd = items.indexOf('/ev');
  const condition =
    evStart >= 0 && evEnd > evStart ? rpnToInfix(items.slice(evStart + 1, evEnd)) : undefined;
  // b 子容器里的第一个真实目标
  const body = named && Array.isArray(named['b']) ? (named['b'] as InkVal[]) : [];
  let target = '';
  for (const b of body) {
    if (isObj(b) && '->' in b && isRealTarget(b['->'], knotNames)) {
      target = b['->'] as string;
      break;
    }
  }
  if (!target) return;
  knot.outgoing.push({
    kind: 'autoConditional',
    target,
    effects: [],
    condition,
    needsReview: true,
    reviewNote: condition ?? '条件分支(else/自动)',
  });
}

function handleTag(knot: ImportedKnot, tagText: string): void {
  const tag = tagText.trim();
  if (!tag) return;
  const video = tag.match(/^video:\s*(.+)$/);
  if (video) {
    knot.videoHint = video[1].trim();
    return;
  }
  if (/^ending:/.test(tag)) knot.isEnding = true;
  knot.tags.push(tag);
}

/** 递归处理容器内容,把片段并入同一 knot。 */
function walk(arr: InkVal[], knot: ImportedKnot, knotNames: Set<string>): void {
  const { items, named } = splitContainer(arr);
  let lastChoiceText: string | null = null;

  for (let i = 0; i < items.length; i++) {
    const el = items[i];

    // 标签块 "#" ... "/#"
    if (el === '#') {
      let j = i + 1;
      const texts: string[] = [];
      while (j < items.length && items[j] !== '/#') {
        const t = items[j];
        if (typeof t === 'string' && t.startsWith('^')) texts.push(t.slice(1));
        j++;
      }
      handleTag(knot, texts.join('').trim());
      i = j;
      continue;
    }

    // 选项文案捕获 "str" ^text "/str"
    if (el === 'str') {
      const next = items[i + 1];
      lastChoiceText = typeof next === 'string' && next.startsWith('^') ? next.slice(1).trim() : '';
      let j = i + 1;
      while (j < items.length && items[j] !== '/str') j++;
      i = j;
      continue;
    }

    if (typeof el === 'string') {
      if (el === 'end' || el === 'done') {
        knot.isEnding = true;
      } else if (el.startsWith('^')) {
        const text = el.slice(1).trim();
        if (text) knot.narration = knot.narration ? `${knot.narration} ${text}` : text;
      }
      // ev / /ev / /str / /# / nop / \n 等控制字忽略
      continue;
    }

    if (Array.isArray(el)) {
      if (isConditional(el)) parseConditional(el, knot, knotNames);
      else walk(el, knot, knotNames); // 嵌套容器(如带选项的 knot 包一层)
      continue;
    }

    if (isObj(el)) {
      // 选项声明 {"*":".^.c-0"}
      if ('*' in el) {
        const path = String(el['*']);
        const key = path.split('.').pop() ?? '';
        const body = named && Array.isArray(named[key]) ? (named[key] as InkVal[]) : [];
        const link: ImportedLink = {
          kind: 'choice',
          text: lastChoiceText ?? '',
          target: '',
          effects: [],
          needsReview: false,
        };
        parseChoiceBody(body, link, knotNames);
        knot.outgoing.push(link);
        lastChoiceText = null;
        continue;
      }
      // 直接跳转
      if ('->' in el && isRealTarget(el['->'], knotNames)) {
        knot.outgoing.push({ kind: 'divert', target: el['->'] as string, effects: [], needsReview: false });
      }
    }
  }
}

/** 从 global decl 容器读变量初值:`n, {"VAR=":name}` 配对。 */
function parseGlobalDecl(decl: InkVal[]): { name: string; initial: number }[] {
  const vars: { name: string; initial: number }[] = [];
  for (let i = 0; i < decl.length; i++) {
    const el = decl[i];
    if (isObj(el) && typeof el['VAR='] === 'string') {
      const prev = decl[i - 1];
      vars.push({ name: el['VAR='] as string, initial: typeof prev === 'number' ? prev : 0 });
    }
  }
  return vars;
}

export function parseInkJson(text: string): ImportedStory {
  const warnings: string[] = [];
  const parsed = JSON.parse(text) as { root?: InkVal[] };
  const root = parsed.root ?? [];

  // 命名内容映射:root 里的纯对象元素。
  const knotMap = (root.find((el) => isObj(el)) as Record<string, unknown> | undefined) ?? {};

  // 起点:root[0] 里第一个 {"->":x}。
  let startKnot = '';
  const head = root[0];
  if (Array.isArray(head)) {
    for (const el of head) {
      if (isObj(el) && typeof el['->'] === 'string') {
        startKnot = el['->'] as string;
        break;
      }
    }
  }

  const knotNames = new Set(
    Object.keys(knotMap).filter((k) => !RESERVED_KEYS.has(k) && !k.startsWith('#')),
  );

  // 变量:优先 global decl,否则从内容扫 VAR? 名收集(初值未知 → 0 + warning)。
  let variables: { name: string; initial: number }[] = [];
  if (Array.isArray(knotMap['global decl'])) {
    variables = parseGlobalDecl(knotMap['global decl'] as InkVal[]);
  }
  if (variables.length === 0) {
    const seen = new Set<string>();
    const scan = (v: InkVal): void => {
      if (Array.isArray(v)) v.forEach(scan);
      else if (isObj(v)) {
        const name = (v['VAR?'] ?? v['VAR=']) as string | undefined;
        if (typeof name === 'string' && !seen.has(name)) {
          seen.add(name);
          variables.push({ name, initial: 0 });
        }
        Object.values(v).forEach((x) => scan(x as InkVal));
      }
    };
    for (const name of knotNames) scan(knotMap[name] as InkVal);
    if (variables.length) warnings.push('变量初值未知,默认 0(无 global decl)');
  }

  const knots: ImportedKnot[] = [];
  for (const name of knotNames) {
    const container = knotMap[name];
    if (!Array.isArray(container)) continue;
    const knot: ImportedKnot = {
      name,
      narration: '',
      tags: [],
      isEnding: false,
      outgoing: [],
      warnings: [],
    };
    walk(container as InkVal[], knot, knotNames);
    knots.push(knot);
  }

  if (!startKnot && knots.length) startKnot = knots[0].name;

  return { variables, startKnot, knots, warnings };
}
