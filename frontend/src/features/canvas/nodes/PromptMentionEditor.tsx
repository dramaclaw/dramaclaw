// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

import type { ReferenceMaterialOption } from '@/features/canvas/application/referencePick';

import { MentionReplacePopover } from './MentionReplacePopover';

export interface MentionCandidate {
  key: string;
  name: string;
  imageUrl: string;
  index: number;
  /**
   * 视频引用的源地址。没有静态首帧图（imageUrl 为空）时，缩略图回退到一个
   * muted 静止 <video preload="metadata">，由浏览器自动定位首帧——与引用行
   * 的视频 chip 同一套渲染。
   */
  videoUrl?: string;
  /** 音频引用的源地址。音频没有缩略图，chip 改为可点击播放的 ▶ 按钮。 */
  audioUrl?: string;
  /**
   * 仅展示用的文件名（音频 chip 显示为 `音频_<displayName>`）。序列化仍用
   * `name`（含编号），传给后端的 `@音频N` 不变。
   */
  displayName?: string | null;
}

interface PromptMentionEditorProps {
  value: string;
  onChange: (next: string) => void;
  candidates: MentionCandidate[];
  placeholder?: string;
  className?: string;
  onCompositionStart?: () => void;
  onCompositionEnd?: (next: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /**
   * 「素材引用」清单：画布上还没被引用、但可以引用的素材。替换选单里选中一条会先
   * 走 onAttachMaterial 建立引用，再把这处 @ 换成它。不传则替换选单只有「已引用」。
   *
   * 传的是取数函数而不是数组：这份清单要遍历整个画布才能算出来，而它只在选单打开
   * 的那一刻有用。做成 prop 数组会逼着每个宿主节点常年订阅整个 nodes 数组，画布上
   * 随便拖一个节点就让所有图片节点重算一遍——代价按节点数平方涨。
   */
  getMaterials?: () => readonly ReferenceMaterialOption[];
  /** 把某个画布素材接成本节点的引用（宿主建边）；返回 false 表示没建成。 */
  onAttachMaterial?: (nodeId: string) => boolean;
}

export interface PromptMentionEditorHandle {
  insertTextAtCursor: (text: string) => void;
  /**
   * 光标处插入一个 @ 引用 chip（引用行上的 @ 按钮走这条）。
   *
   * 不走 insertTextAtCursor('@图片1 ')：那是纯文本，序列化虽然一样，但要等到下一次
   * 外部 value 变化才会被 rebuildDOM 认成 chip——commitChange 刚把新串写进
   * lastSerializedRef，回流时 sync 那步会直接 return。用户看到的是一串裸文字。
   */
  insertMentionAtCursor: (candidate: MentionCandidate) => void;
  focus: () => void;
}

// Visible row count before the popover starts scrolling. The full filtered
// list is still rendered — see the `max-h` + `overflow-y-auto` on the
// container below — so callers with >6 references (e.g. video 图片参考 takes
// up to 9) can still pick a later one.
const POPOVER_MAX_VISIBLE = 6;
// Each row is ~40px (py-1.5 + h-7 image + 1px borders). Computed once so the
// max-height tracks the row count consistently.
const POPOVER_ROW_PX = 40;
const PREVIEW_SIZE = 140;
const POPOVER_OFFSET_Y = 4;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 前端展示用：把 mention 的「图片1 / 音频2」去掉尾号，统一显示为「图片 / 音频」。
// 仅影响显示——序列化仍用 dataset.name（含编号），传给后端的 prompt 保持 @图片N。
export function mentionDisplayLabel(name: string): string {
  return name.replace(/\d+$/, '') || name;
}

// 音频 chip 展示为「音频_文件名」（图片/视频有缩略图，无需文件名）。序列化不受
// 影响（仍走 dataset.name）。这是「完整」标签，用于 title / 候选列表。
export function mentionChipLabel(candidate: MentionCandidate): string {
  const base = mentionDisplayLabel(candidate.name);
  const file = candidate.displayName?.trim();
  if (candidate.audioUrl && file) {
    return `${base}_${file}`;
  }
  return base;
}

// chip 内可见标签最多 10 个字符，超出用省略号；完整名走 title。按码点切，避免把
// 代理对（emoji 等）切坏。
const CHIP_LABEL_MAX_CHARS = 10;

export function truncateChipLabel(text: string, max = CHIP_LABEL_MAX_CHARS): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

function buildChipElement(candidate: MentionCandidate): HTMLElement {
  const span = document.createElement('span');
  span.contentEditable = 'false';
  span.dataset.mention = candidate.key;
  span.dataset.name = candidate.name;
  span.dataset.imageUrl = candidate.imageUrl;
  if (candidate.videoUrl) span.dataset.videoUrl = candidate.videoUrl;
  if (candidate.audioUrl) span.dataset.audioUrl = candidate.audioUrl;
  span.className = 'mention-chip';
  const label = mentionChipLabel(candidate);
  if (candidate.imageUrl) {
    span.title = '双击替换引用';
    const img = document.createElement('img');
    img.src = candidate.imageUrl;
    img.alt = '';
    img.draggable = false;
    span.appendChild(img);
  } else if (candidate.videoUrl) {
    span.title = '双击替换引用';
    // 没有静态首帧图时，用 muted 静止 <video> 显示首帧——与候选行 / 引用行一致。
    const video = document.createElement('video');
    video.src = candidate.videoUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.draggable = false;
    span.appendChild(video);
  } else if (candidate.audioUrl) {
    // 音频没有缩略图：放一个可点击的 ▶/⏸ 播放按钮（::before 画图标，播放态由
    // chip 上的 data-audio-playing 切换）。hover 时 title 给出完整文件名。
    span.classList.add('mention-chip-audio');
    span.title = `${label} · 点击播放`;
    const play = document.createElement('span');
    play.className = 'mention-chip-audio-play';
    play.dataset.audioPlay = '';
    play.setAttribute('aria-hidden', 'true');
    span.appendChild(play);
  } else {
    span.title = '双击替换引用';
  }
  const labelEl = document.createElement('span');
  labelEl.className = 'mention-chip-label';
  labelEl.textContent = truncateChipLabel(label);
  span.appendChild(labelEl);
  // hover 时顶掉缩略图的替换按钮。「这处 @ 可以换成别的素材」以前只有双击能发现，
  // 等于没有；图片 / 视频把它放在缩略图的位置（CSS 里 hover 互换），音频那格已经
  // 被播放键占着，就挂到标签后面。
  const swap = document.createElement('span');
  swap.className = 'mention-chip-swap';
  swap.dataset.mentionSwap = '';
  swap.title = '替换引用';
  swap.setAttribute('aria-hidden', 'true');
  if (candidate.imageUrl || candidate.videoUrl) {
    span.insertBefore(swap, span.firstChild);
  } else {
    span.appendChild(swap);
  }
  return span;
}

function appendTextWithLineBreaks(root: HTMLElement, text: string): void {
  const parts = text.split('\n');
  parts.forEach((part, idx) => {
    if (part.length > 0) {
      root.appendChild(document.createTextNode(part));
    }
    if (idx < parts.length - 1) {
      root.appendChild(document.createElement('br'));
    }
  });
}

function selectionBelongsTo(root: HTMLElement, selection: Selection): boolean {
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return Boolean(
    anchor
    && root.contains(anchor)
    && (!focus || root.contains(focus))
  );
}

function rangeAtEndOf(root: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

function insertPlainTextAtRange(range: Range, text: string): Range {
  range.deleteContents();

  const fragment = document.createDocumentFragment();
  let lastNode: Node | null = null;
  const parts = text.split('\n');
  parts.forEach((part, idx) => {
    if (part.length > 0) {
      const textNode = document.createTextNode(part);
      fragment.appendChild(textNode);
      lastNode = textNode;
    }
    if (idx < parts.length - 1) {
      const br = document.createElement('br');
      fragment.appendChild(br);
      lastNode = br;
    }
  });

  range.insertNode(fragment);

  const after = document.createRange();
  if (lastNode) {
    after.setStartAfter(lastNode);
  } else {
    after.setStart(range.startContainer, range.startOffset);
  }
  after.collapse(true);
  return after;
}

function rebuildDOM(root: HTMLElement, text: string, candidates: MentionCandidate[]): void {
  while (root.firstChild) {
    root.removeChild(root.firstChild);
  }
  if (!text) return;
  const names = candidates
    .map((c) => c.name)
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) {
    appendTextWithLineBreaks(root, text);
    return;
  }
  const pattern = new RegExp('@(' + names.map(escapeRegex).join('|') + ')', 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendTextWithLineBreaks(root, text.slice(lastIndex, match.index));
    }
    const name = match[1];
    const candidate = candidates.find((c) => c.name === name);
    if (candidate) {
      root.appendChild(buildChipElement(candidate));
    } else {
      appendTextWithLineBreaks(root, match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    appendTextWithLineBreaks(root, text.slice(lastIndex));
  }
}

function serialize(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.mention) {
      out += '@' + (el.dataset.name ?? '');
      return;
    }
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    if (el.tagName === 'DIV') {
      if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      for (const child of Array.from(el.childNodes)) walk(child);
      return;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  for (const child of Array.from(root.childNodes)) walk(child);
  return out;
}

interface MentionContext {
  textNode: Text;
  atOffset: number;
  caretOffset: number;
  query: string;
  rect: DOMRect;
}

/**
 * Walk back from the caret inside a text node to find a fresh `@token`.
 * Fires on any `@` (regardless of the preceding character) so `111@` triggers
 * the picker just like `111 @` does — this is an asset-reference prompt field,
 * not an email input, so the `@` is always a deliberate mention trigger.
 */
function detectMention(): MentionContext | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const textNode = node as Text;
  const caretOffset = range.startOffset;
  const textBefore = (textNode.textContent ?? '').slice(0, caretOffset);
  const match = textBefore.match(/@([^\s@]*)$/);
  if (!match) return null;
  const atIndex = textBefore.length - match[0].length;
  const rect = range.getBoundingClientRect();
  return {
    textNode,
    atOffset: atIndex,
    caretOffset,
    query: match[1],
    rect,
  };
}

interface HoverState {
  imageUrl: string;
  videoUrl: string;
  rect: DOMRect;
}

export const PromptMentionEditor = forwardRef<PromptMentionEditorHandle, PromptMentionEditorProps>(
  function PromptMentionEditor(
    {
      value,
      onChange,
      candidates,
      placeholder,
      className,
      onCompositionStart,
      onCompositionEnd,
      onKeyDown,
      getMaterials,
      onAttachMaterial,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const lastSerializedRef = useRef<string>('');
    const isComposingRef = useRef(false);
    // 单个共享 <audio>：点击音频 chip 播放/暂停该引用；切到别条会先停掉上一条。
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const playingUrlRef = useRef<string | null>(null);
    const [mention, setMention] = useState<MentionContext | null>(null);
    const [activeIdx, setActiveIdx] = useState(0);
    const [hover, setHover] = useState<HoverState | null>(null);
    // 双击已有的 @ chip → 打开候选列表「就地替换」该引用（锚定在被双击的 chip 上）。
    // 与 `mention`（输入 @ 触发的插入）互斥：一个开另一个必置空。
    const [replaceTarget, setReplaceTarget] = useState<{
      el: HTMLElement;
      rect: DOMRect;
      /** 打开那一刻的素材快照，见 getMaterials。 */
      materials: readonly ReferenceMaterialOption[];
    } | null>(null);
    // 选了一条还没引用的素材：宿主先建边，等它出现在 candidates 里（有了编号）之后
    // 才好把 chip 换过去——在那之前我们连该写 @图片几都不知道。
    const pendingAttachRef = useRef<{ el: HTMLElement; key: string } | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);

    // External value → DOM sync. Only re-render if the incoming value
    // differs from our own last-emitted serialization, otherwise we'd
    // wipe the caret on every keystroke.
    useLayoutEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      if (value === lastSerializedRef.current) return;
      rebuildDOM(el, value, candidates);
      lastSerializedRef.current = value;
    }, [value, candidates]);

    const commitChange = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const next = serialize(el);
      if (next === lastSerializedRef.current) return;
      lastSerializedRef.current = next;
      onChange(next);
    }, [onChange]);

    const insertTextAtCursor = useCallback(
      (text: string) => {
        const el = editorRef.current;
        if (!el || text.length === 0) return;

        el.focus();
        const selection = window.getSelection();
        const range = selection && selection.rangeCount > 0 && selectionBelongsTo(el, selection)
          ? selection.getRangeAt(0).cloneRange()
          : rangeAtEndOf(el);
        const after = insertPlainTextAtRange(range, text);
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(after);
        }
        setMention(null);
        commitChange();
      },
      [commitChange],
    );

    const insertMentionAtCursor = useCallback(
      (candidate: MentionCandidate) => {
        const el = editorRef.current;
        if (!el) return;

        el.focus();
        const selection = window.getSelection();
        const range =
          selection && selection.rangeCount > 0 && selectionBelongsTo(el, selection)
            ? selection.getRangeAt(0).cloneRange()
            : rangeAtEndOf(el);
        range.deleteContents();
        const chip = buildChipElement(candidate);
        range.insertNode(chip);
        // 和从候选列表插入一样补一个尾随空格，光标落在它后面，接着打字不会黏在 chip 上。
        const space = document.createTextNode(' ');
        chip.parentNode?.insertBefore(space, chip.nextSibling);
        if (selection) {
          const after = document.createRange();
          after.setStartAfter(space);
          after.collapse(true);
          selection.removeAllRanges();
          selection.addRange(after);
        }
        setMention(null);
        commitChange();
      },
      [commitChange],
    );

    useImperativeHandle(
      ref,
      () => ({
        insertTextAtCursor,
        insertMentionAtCursor,
        focus: () => editorRef.current?.focus(),
      }),
      [insertTextAtCursor, insertMentionAtCursor],
    );

    const clearPlayingState = useCallback(() => {
      playingUrlRef.current = null;
      editorRef.current
        ?.querySelectorAll('.mention-chip[data-audio-playing]')
        .forEach((el) => el.removeAttribute('data-audio-playing'));
    }, []);

    // 点击音频 chip 的 ▶ 按钮：播放/暂停该引用。再次点正在播放的同一条 → 暂停；
    // 点另一条 → 先停上一条再播。播放成功后给 chip 打 data-audio-playing（::before
    // 切到 ⏸），结束时清掉。
    const toggleAudio = useCallback(
      (chip: HTMLElement) => {
        const url = chip.dataset.audioUrl;
        if (!url) return;
        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio();
          audio.addEventListener('ended', clearPlayingState);
          audioRef.current = audio;
        }
        if (playingUrlRef.current === url && !audio.paused) {
          audio.pause();
          clearPlayingState();
          return;
        }
        clearPlayingState();
        audio.pause();
        audio.src = url;
        playingUrlRef.current = url;
        void audio
          .play()
          .then(() => {
            if (playingUrlRef.current === url) chip.setAttribute('data-audio-playing', '');
          })
          .catch(() => {
            if (playingUrlRef.current === url) clearPlayingState();
          });
      },
      [clearPlayingState],
    );

    useEffect(() => {
      return () => {
        audioRef.current?.pause();
        audioRef.current = null;
      };
    }, []);

    const filtered = useMemo(() => {
      if (!mention) return candidates;
      const q = mention.query.toLowerCase();
      if (!q) return candidates;
      return candidates.filter((c) => c.name.toLowerCase().includes(q));
    }, [mention, candidates]);

    useEffect(() => {
      setActiveIdx(0);
    }, [mention?.query, mention?.atOffset, replaceTarget]);

    const handleInput = useCallback(() => {
      if (isComposingRef.current) return;
      // 一旦开始打字就退出「替换」态，回到正常输入 / 插入流程。
      setReplaceTarget(null);
      commitChange();
      setMention(detectMention());
    }, [commitChange]);

    // contentEditable's default paste injects the source's rich HTML, which
    // drags along inline color/font styling — e.g. black text copied from
    // elsewhere becomes invisible against the dark editor. Force plain text
    // instead (same approach as EditableTableCell). execCommand fires a native
    // input event, so handleInput re-commits + re-runs mention detection.
    const handlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const plain = event.clipboardData.getData('text/plain');
      if (!plain) return;
      document.execCommand('insertText', false, plain);
    }, []);

    const insertChip = useCallback(
      (candidate: MentionCandidate) => {
        const ctx = mention;
        const el = editorRef.current;
        if (!ctx || !el) return;
        const sel = window.getSelection();
        if (!sel) return;

        // Replace `@query` text with the chip. Use the cached atOffset
        // anchor — caret-relative recomputation is fragile after React
        // re-renders touch surrounding nodes.
        const range = document.createRange();
        range.setStart(ctx.textNode, ctx.atOffset);
        const currentRange = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        if (
          currentRange
          && currentRange.endContainer === ctx.textNode
          && currentRange.endOffset >= ctx.atOffset
        ) {
          range.setEnd(currentRange.endContainer, currentRange.endOffset);
        } else {
          range.setEnd(ctx.textNode, ctx.caretOffset);
        }
        range.deleteContents();
        const chip = buildChipElement(candidate);
        range.insertNode(chip);

        // Drop a trailing space and put the caret after it so the next
        // keystroke continues naturally.
        const space = document.createTextNode(' ');
        const parent = chip.parentNode;
        if (parent) {
          parent.insertBefore(space, chip.nextSibling);
        }
        const after = document.createRange();
        after.setStartAfter(space);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);

        setMention(null);
        commitChange();
      },
      [mention, commitChange],
    );

    // 就地替换被双击的 chip：用新候选造一个 chip 顶替旧节点，光标落到其后，
    // 然后重新序列化提交。引用队列不变 —— 只是这个 mention 改指向另一个已有资源。
    const replaceChip = useCallback(
      (chipEl: HTMLElement, candidate: MentionCandidate) => {
        const el = editorRef.current;
        setReplaceTarget(null);
        if (!el || !el.contains(chipEl)) return;
        const fresh = buildChipElement(candidate);
        chipEl.replaceWith(fresh);
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.setStartAfter(fresh);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        commitChange();
      },
      [commitChange],
    );

    // 在某颗 chip 下方打开替换选单。两个入口共用：hover 出来的替换图标，和双击
    // chip（老习惯，留着）。
    const openReplaceFor = useCallback(
      (chip: HTMLElement) => {
        const materials = getMaterials?.() ?? [];
        if (candidates.length === 0 && materials.length === 0) return;
        pendingAttachRef.current = null;
        setMention(null);
        setHover(null);
        setReplaceTarget({ el: chip, rect: chip.getBoundingClientRect(), materials });
      },
      [candidates.length, getMaterials],
    );

    // 双击 @ chip → 在它下方打开候选列表，快速替换该引用，省去「删 chip 再 @」。
    const handleDoubleClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        const chip = (event.target as HTMLElement | null)?.closest('.mention-chip');
        if (!(chip instanceof HTMLElement) || !chip.dataset.mention) return;
        event.preventDefault();
        event.stopPropagation();
        openReplaceFor(chip);
      },
      [openReplaceFor],
    );

    // 选了一条画布素材：先让宿主建边，再等它带着编号进入 candidates。
    // 建边期间 prompt 文本没变，rebuildDOM 不会跑，所以这里握着的 chip 元素仍然有效。
    // 建边被拒（比如超了素材上限，宿主已经弹过 toast）就别留 pending——留下的话，
    // 用户过一阵子从别的入口把同一个节点连上时，这颗早就失去上下文的 chip 会被悄悄改掉。
    const attachMaterial = useCallback(
      (chipEl: HTMLElement, nodeId: string) => {
        setReplaceTarget(null);
        if (!onAttachMaterial) return;
        if (!onAttachMaterial(nodeId)) return;
        pendingAttachRef.current = { el: chipEl, key: nodeId };
      },
      [onAttachMaterial],
    );

    // 替换态下，点击 popover 以外的任意地方都关闭它（捕获阶段，先于 React 冒泡）。
    useEffect(() => {
      if (!replaceTarget) return;
      const onDocMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (popoverRef.current && target && popoverRef.current.contains(target)) {
          return;
        }
        setReplaceTarget(null);
      };
      document.addEventListener('mousedown', onDocMouseDown, true);
      return () => document.removeEventListener('mousedown', onDocMouseDown, true);
    }, [replaceTarget]);

    // 新引用连上后 candidates 会多出这一条（带好编号），这时才把 chip 换过去。
    // 只等这一轮：边已经建成了，candidates 必然在同一次更新里重算，这时还找不到它
    // 就是宿主根本给不出这个候选（例如两个节点指向同一张图，编号只认第一个），
    // 那就到此为止——继续挂着只会在很久以后误改一颗无关的 chip。
    useEffect(() => {
      const pending = pendingAttachRef.current;
      if (!pending) return;
      pendingAttachRef.current = null;
      const candidate = candidates.find((item) => item.key === pending.key);
      if (candidate) replaceChip(pending.el, candidate);
    }, [candidates, replaceChip]);

    const handleKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
        // 替换选单自带搜索框和鼠标操作，键盘（含 Escape）归它自己处理——它一打开
        // 焦点就落在自己的搜索框上，这个 handler 根本收不到键。这里只管 @ 输入
        // 触发的候选列表。
        const popoverOpen = Boolean(mention) && filtered.length > 0;
        if (popoverOpen) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIdx((i) => (i + 1) % filtered.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            insertChip(filtered[activeIdx]);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setMention(null);
            setReplaceTarget(null);
            return;
          }
        }
        if (event.key === 'Escape') {
          setHover(null);
        }
        onKeyDown?.(event);
      },
      [mention, filtered, activeIdx, insertChip, onKeyDown],
    );

    const handleClick = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        const swapEl = (event.target as HTMLElement | null)?.closest('[data-mention-swap]');
        if (swapEl) {
          const chip = swapEl.closest('.mention-chip');
          if (chip instanceof HTMLElement && chip.dataset.mention) {
            event.preventDefault();
            openReplaceFor(chip);
          }
          return;
        }
        const playEl = (event.target as HTMLElement | null)?.closest('[data-audio-play]');
        if (!playEl) return;
        const chip = playEl.closest('.mention-chip');
        if (chip instanceof HTMLElement) {
          event.preventDefault();
          toggleAudio(chip);
        }
      },
      [openReplaceFor, toggleAudio],
    );

    const handleMouseOver = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-mention]');
      if (!(target instanceof HTMLElement)) {
        setHover(null);
        return;
      }
      const imageUrl = target.dataset.imageUrl ?? '';
      const videoUrl = target.dataset.videoUrl ?? '';
      if (!imageUrl && !videoUrl) return;
      setHover({ imageUrl, videoUrl, rect: target.getBoundingClientRect() });
    }, []);

    const handleMouseOut = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-mention]');
      if (!(target instanceof HTMLElement)) return;
      const related = event.relatedTarget as Node | null;
      if (related && target.contains(related)) return;
      setHover(null);
    }, []);

    // Attach as `ref` only on the currently-active row. When activeIdx changes
    // the ref detaches from the old button (null) and attaches to the new one
    // (the element), at which point we nudge it into the visible viewport.
    // Without this, Arrow Down past the 6th row hides the highlight behind the
    // scroll edge.
    const scrollActiveIntoView = useCallback((el: HTMLButtonElement | null) => {
      if (el) el.scrollIntoView({ block: 'nearest' });
    }, []);

    const popoverStyle = useMemo(() => {
      const rect = mention?.rect ?? null;
      if (!rect) return null;
      const top = rect.bottom + POPOVER_OFFSET_Y;
      const left = rect.left;
      return { top, left } as { top: number; left: number };
    }, [mention]);

    const previewStyle = useMemo(() => {
      if (!hover) return null;
      const left = Math.min(
        Math.max(8, hover.rect.left),
        window.innerWidth - PREVIEW_SIZE - 8,
      );
      // 浮层用 -translate-y-full 把自身抬到 chip 上方,top 只需落在 chip 顶边稍上,
      // 这样高度按图/视频原始宽高比自适应,不再裁成正方形。
      const top = hover.rect.top - 8;
      return { left, top };
    }, [hover]);

    return (
      <>
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className={`prompt-mention-editor cursor-text ${className ?? ''}`}
          data-placeholder={placeholder ?? ''}
          spellCheck={false}
          onInput={handleInput}
          onPaste={handlePaste}
          onCompositionStart={() => {
            isComposingRef.current = true;
            onCompositionStart?.();
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            commitChange();
            setMention(detectMention());
            const el = editorRef.current;
            if (el) onCompositionEnd?.(serialize(el));
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
        />
        {mention && popoverStyle && filtered.length > 0
          && createPortal(
            <div
              ref={popoverRef}
              className="canvas-node-transient-ui ui-scrollbar fixed z-[10000] flex min-w-[200px] max-w-[280px] flex-col overflow-y-auto rounded-lg border border-white/10 bg-surface-dark/95 shadow-xl backdrop-blur-sm"
              style={{
                ...popoverStyle,
                maxHeight: POPOVER_MAX_VISIBLE * POPOVER_ROW_PX,
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {filtered.map((candidate, idx) => (
                <button
                  key={candidate.key}
                  type="button"
                  ref={idx === activeIdx ? scrollActiveIntoView : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    insertChip(candidate);
                  }}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                    idx === activeIdx
                      ? 'bg-white/[0.08] text-text-dark'
                      : 'text-text-muted hover:bg-white/[0.05] hover:text-text-dark'
                  }`}
                >
                  {candidate.imageUrl ? (
                    <img
                      src={candidate.imageUrl}
                      alt=""
                      className="h-7 w-7 shrink-0 rounded object-cover"
                      draggable={false}
                    />
                  ) : candidate.videoUrl ? (
                    <video
                      src={candidate.videoUrl}
                      className="h-7 w-7 shrink-0 rounded object-cover"
                      muted
                      playsInline
                      preload="metadata"
                      draggable={false}
                    />
                  ) : (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white/[0.06] text-[13px] text-accent">
                      ♪
                    </span>
                  )}
                  <span className="flex-1 truncate">{mentionChipLabel(candidate)}</span>
                  <span className="text-[10px] text-text-muted/70">@{candidate.index}</span>
                </button>
              ))}
            </div>,
            document.body,
          )}
        {replaceTarget
          && createPortal(
            <div ref={popoverRef}>
              <MentionReplacePopover
                anchorRect={replaceTarget.rect}
                referenced={candidates}
                materials={replaceTarget.materials}
                onPickReferenced={(candidate) => replaceChip(replaceTarget.el, candidate)}
                onPickMaterial={(material) =>
                  attachMaterial(replaceTarget.el, material.nodeId)
                }
                onClose={() => setReplaceTarget(null)}
              />
            </div>,
            document.body,
          )}
        {hover && previewStyle
          && createPortal(
            <div
              className="canvas-node-transient-ui pointer-events-none fixed z-[10001] -translate-y-full overflow-hidden rounded-lg border border-white/15 bg-surface-dark/95 shadow-xl"
              style={{
                left: previewStyle.left,
                top: previewStyle.top,
                width: PREVIEW_SIZE,
              }}
            >
              {hover.imageUrl ? (
                <img
                  src={hover.imageUrl}
                  alt=""
                  className="block h-auto max-h-[220px] w-full object-contain"
                  draggable={false}
                />
              ) : (
                <video
                  src={hover.videoUrl}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="block h-auto max-h-[220px] w-full object-contain"
                />
              )}
            </div>,
            document.body,
          )}
      </>
    );
  },
);
