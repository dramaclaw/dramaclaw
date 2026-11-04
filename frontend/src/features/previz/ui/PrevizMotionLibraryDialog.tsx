// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Pencil, Trash2, Upload, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { actionClipsUsing, planActionClip, type ActionInsertRejection } from '../domain/actionClips';
import type { PrevizCharacterDraft } from '../domain/characterDraft';
import { PREVIZ_MOTION_LIMITS } from '../domain/limits';
import {
  PREVIZ_BUILTIN_MOTIONS,
  PREVIZ_MOTION_CATEGORIES,
  importMotionRef,
  importedIdOf,
  type PrevizMotionCategory,
  type PrevizMotionLoadError,
  type PrevizMotionStatus,
} from '../domain/motionLibrary';
import type { PrevizCharacter, PrevizImportedMotion, PrevizScene } from '../domain/scene';
import { clipById } from '../domain/timeline';
import { PREVIZ_CHARACTER_PREVIEW_SIZE } from '../engine/characterPreview';
import type { PrevizMotionPick, PrevizStagedMotionImport } from '../motionImport';
import type { PrevizMotionDialog } from '../store';
import { motionErrorText } from './motionLabel';
import { PrevizMotionImportPanel } from './PrevizMotionImportPanel';
import { useMotionPreview, type PrevizMotionPreviewRender } from './useMotionPreview';

/** 与模型库同一套：图标按钮不描边，悬停浮起一层底色。 */
const STEP_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/45 transition-colors hover:bg-white/10 hover:text-white/90';
const RAIL_ITEM =
  'flex h-8 items-center justify-between gap-2 rounded-md px-2 text-left text-[12px] text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/90 aria-pressed:bg-white/10 aria-pressed:text-white/90';
const CARD =
  'flex w-full flex-col items-start gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-2 text-left text-white/60 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white/90 aria-pressed:border-[#3fae5f] aria-pressed:text-white/90';
const PRIMARY =
  'inline-flex h-8 items-center rounded-md bg-[#3fae5f] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#4cc26d] disabled:cursor-not-allowed disabled:opacity-40';
const SECONDARY =
  'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] text-white/60 transition-colors hover:bg-white/10 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40';

export type PrevizMotionCardCategory = PrevizMotionCategory | 'imported';

export interface PrevizMotionCard {
  id: string;
  name: string;
  category: PrevizMotionCardCategory;
  durationSec: number;
  loop: boolean;
  /** 搜索用的小写文本：本地化名 + 英文 clip 名（下划线换成空格）或导入文件名。 */
  haystack: string;
}

/** 内置目录在前、导入的在后，顺序即卡片顺序。 */
export function motionCards(t: TFunction, motions: readonly PrevizImportedMotion[]): PrevizMotionCard[] {
  const builtin = PREVIZ_BUILTIN_MOTIONS.map((motion) => {
    const name = t(motion.labelKey);
    return {
      id: motion.id,
      name,
      category: motion.category,
      durationSec: motion.durationSec,
      loop: motion.loop,
      haystack: `${name} ${motion.clipName} ${motion.clipName.replace(/_/g, ' ')}`.toLowerCase(),
    };
  });
  const imported = motions.map((motion) => ({
    id: importMotionRef(motion.id),
    name: motion.name,
    category: 'imported' as const,
    durationSec: motion.durationSec,
    loop: motion.loop,
    haystack: `${motion.name} ${motion.sourceFileName}`.toLowerCase(),
  }));
  return [...builtin, ...imported];
}

/**
 * 搜索框空着时按分类筛；一旦输入就搜全部分类。74 条分在五类里，用户敲「走路」时
 * 多半不知道它归「移动」还是「日常」，只在当前分类里搜会得到一个空网格。
 */
export function filterMotionCards(
  cards: readonly PrevizMotionCard[],
  category: PrevizMotionCardCategory,
  query: string,
): PrevizMotionCard[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards.filter((card) => card.category === category);
  return cards.filter((card) => card.haystack.includes(needle));
}

/** 预览用人物现在的样子：体型、身高、辨识色、基础姿势都照抄，站位留空走默认机位。 */
function draftOf(character: PrevizCharacter): PrevizCharacterDraft {
  return {
    name: character.name,
    color: character.color,
    bodyType: character.bodyType,
    heightCm: character.heightCm,
    basePoseId: character.basePoseId,
    poseAdjust: character.poseAdjust,
    heightPolicy: character.heightPolicy,
    avoidCollision: character.avoidCollision,
    stayInBounds: character.stayInBounds,
    spot: null,
  };
}

export interface PrevizMotionLibraryDialogProps {
  request: PrevizMotionDialog | null;
  scene: PrevizScene;
  /** 播放头。「添加」从这里起算落点。 */
  frame: number;
  motionStatus: Readonly<Record<string, PrevizMotionStatus>>;
  onRenderPreview: PrevizMotionPreviewRender;
  /** 放不下时返回原因，对话框留着并把原因写出来。 */
  onAdd: (objectId: string, motionId: string) => ActionInsertRejection | null;
  onReplace: (clipId: string, motionId: string) => void;
  onClose: () => void;
  /** 本地读文件、试跑重定向，并把候选 clip prime 进渲染器。不发任何网络请求。 */
  onStageImport: (file: File) => Promise<PrevizStagedMotionImport>;
  /** 上传并写进场景；没勾的候选由它丢掉。失败返回 false，确认框留着让人重试或取消。 */
  onCommitImport: (
    file: File,
    staged: Extract<PrevizStagedMotionImport, { ok: true }>,
    picks: PrevizMotionPick[],
  ) => Promise<boolean>;
  /** 取消导入：丢掉 `onStageImport` prime 进去的那几条。 */
  onDiscardImport: (importedIds: string[]) => void;
  onRenameMotion: (importedId: string, name: string) => void;
  /** 连同引用它的片段一起删。 */
  onRemoveMotion: (importedId: string) => void;
}

type ImportState =
  | { phase: 'idle'; error: PrevizMotionLoadError | null }
  | { phase: 'reading' }
  | { phase: 'confirm'; file: File; staged: Extract<PrevizStagedMotionImport, { ok: true }>; uploading: boolean };

/**
 * 动作库：左栏分类、中间卡片、右边拿当前人物循环播放所选动作。
 *
 * 铺在视口上而不是再套一层 base-ui Dialog，理由同模型库：编辑器本身已经是个全屏
 * Dialog，嵌套会把焦点陷阱和 Esc 各劫持一遍。
 */
export function PrevizMotionLibraryDialog({ request, scene, ...props }: PrevizMotionLibraryDialogProps) {
  if (!request) return null;
  // 「更换」要找到片段所在的人；片段或人物在对话框开着时被撤销掉，就什么都不画。
  const found = request.mode === 'replace' ? clipById(scene, request.clipId) : undefined;
  const objectId = request.mode === 'add' ? request.objectId : found?.table === 'tracks' ? found.track.objectId : null;
  const character = scene.objects.find((object) => object.id === objectId);
  if (character?.kind !== 'character') return null;
  const currentMotionId = found?.clip.kind === 'action' ? found.clip.motionId : null;
  return (
    <LibraryPanel
      // 换了请求（另一个人、另一段片段）就整个重来：分类、搜索、选中都不该串过去。
      key={request.mode === 'add' ? `add:${request.objectId}` : `replace:${request.clipId}`}
      request={request}
      scene={scene}
      character={character}
      currentMotionId={currentMotionId}
      {...props}
    />
  );
}

function LibraryPanel({
  request,
  scene,
  character,
  currentMotionId,
  frame,
  motionStatus,
  onRenderPreview,
  onAdd,
  onReplace,
  onClose,
  onStageImport,
  onCommitImport,
  onDiscardImport,
  onRenameMotion,
  onRemoveMotion,
}: Omit<PrevizMotionLibraryDialogProps, 'request'> & {
  request: PrevizMotionDialog;
  character: PrevizCharacter;
  currentMotionId: string | null;
}) {
  const { t } = useTranslation();
  const cards = useMemo(() => motionCards(t, scene.motions), [t, scene.motions]);
  const [selected, setSelected] = useState<string | null>(currentMotionId);
  const [category, setCategory] = useState<PrevizMotionCardCategory>(
    () => cards.find((card) => card.id === currentMotionId)?.category ?? 'daily',
  );
  const [query, setQuery] = useState('');
  const [rejected, setRejected] = useState<ActionInsertRejection | null>(null);
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle', error: null });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const matches = filterMotionCards(cards, category, query);
  const picked = cards.find((card) => card.id === selected) ?? null;
  const draft = useMemo(() => draftOf(character), [character]);
  useMotionPreview(canvasRef, draft, picked?.id ?? null, picked?.durationSec ?? 1, onRenderPreview);

  // 确认框里 prime 着、还没进场景的那几条。对话框不管以哪种方式消失（关闭、撤销掉人物），
  // 都得把它们交还，否则解析好的 clip 一直挂在渲染器的缓存里。
  const stagedIdsRef = useRef<string[]>([]);
  const mountedRef = useRef(true);
  const discardStaged = () => {
    const ids = stagedIdsRef.current;
    stagedIdsRef.current = [];
    if (ids.length > 0) onDiscardImport(ids);
  };
  const discardRef = useRef(discardStaged);
  discardRef.current = discardStaged;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardRef.current();
    };
  }, []);

  const plan =
    request.mode === 'add' && selected ? planActionClip(scene, request.objectId, selected, frame) : null;
  const reason = rejected ?? (plan && !plan.ok ? plan.reason : null);
  const canConfirm =
    selected !== null && (request.mode === 'add' ? plan?.ok === true : selected !== currentMotionId);
  const room = PREVIZ_MOTION_LIMITS.imported - scene.motions.length;

  const confirm = () => {
    if (!selected || !canConfirm) return;
    if (request.mode === 'replace') {
      onReplace(request.clipId, selected);
      onClose();
      return;
    }
    // 规划和真正插入之间场景可能又变了（协同、撤销），以 store 的回答为准。
    const result = onAdd(request.objectId, selected);
    if (result) setRejected(result);
    else onClose();
  };

  const close = () => {
    discardStaged();
    onClose();
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 清掉 value：同一个文件改完再选一次，浏览器不会再发 change。
    event.target.value = '';
    if (!file) return;
    setImportState({ phase: 'reading' });
    const staged = await onStageImport(file);
    if (!mountedRef.current) {
      if (staged.ok) onDiscardImport(staged.clips.map((clip) => clip.id));
      return;
    }
    if (!staged.ok) {
      setImportState({ phase: 'idle', error: staged.error });
      return;
    }
    stagedIdsRef.current = staged.clips.map((clip) => clip.id);
    setImportState({ phase: 'confirm', file, staged, uploading: false });
  };

  const commitImport = async (picks: PrevizMotionPick[]) => {
    if (importState.phase !== 'confirm') return;
    const { file, staged } = importState;
    setImportState({ ...importState, uploading: true });
    const ok = await onCommitImport(file, staged, picks);
    if (!mountedRef.current) return;
    if (!ok) {
      setImportState({ phase: 'confirm', file, staged, uploading: false });
      return;
    }
    // 交给场景了：不勾的那几条由 `onCommitImport` 丢，这边不再管。
    stagedIdsRef.current = [];
    setImportState({ phase: 'idle', error: null });
    setQuery('');
    setSelected(importMotionRef(picks[0]!.id));
    setRejected(null);
  };

  const cancelImport = () => {
    discardStaged();
    setImportState({ phase: 'idle', error: null });
  };

  const finishRename = () => {
    if (!renaming) return;
    onRenameMotion(renaming.id, renaming.name);
    setRenaming(null);
  };

  const title = t(request.mode === 'add' ? 'previz.motion.library.titleAdd' : 'previz.motion.library.titleReplace');
  const rail: PrevizMotionCardCategory[] = [...PREVIZ_MOTION_CATEGORIES, 'imported'];
  const removing = removingId === null ? undefined : scene.motions.find((motion) => motion.id === removingId);
  const showImportBar = category === 'imported' && !query.trim();

  return (
    <section
      role="dialog"
      aria-modal="true"
      // 空白处点击就地接住焦点，编辑器快捷键不穿透过来，见 PrevizModelLibraryDialog。
      tabIndex={-1}
      aria-label={title}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6"
    >
      <div className="relative flex h-full max-h-[600px] w-full max-w-[980px] flex-col gap-3 rounded-xl border border-white/10 bg-[#14161b] p-4 shadow-2xl">
        <header className="flex items-center justify-between">
          <h4 className="text-[13px] font-medium text-white/90">
            {title} · {character.name}
          </h4>
          <button type="button" className={STEP_BUTTON} aria-label={t('previz.motion.library.close')} onClick={close}>
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        {importState.phase === 'confirm' ? (
          <PrevizMotionImportPanel
            fileName={importState.file.name}
            staged={importState.staged}
            room={room}
            uploading={importState.uploading}
            draft={draft}
            onRenderPreview={onRenderPreview}
            onCancel={cancelImport}
            onConfirm={(picks) => void commitImport(picks)}
          />
        ) : (
          <>
            <div className="flex min-h-0 flex-1 gap-4">
              <nav aria-label={t('previz.motion.library.categories')} className="flex w-32 shrink-0 flex-col gap-0.5">
                {rail.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={category === value}
                    className={RAIL_ITEM}
                    onClick={() => {
                      setCategory(value);
                      setQuery('');
                    }}
                  >
                    <span className="truncate">{t(`previz.motion.category.${value}`)}</span>
                    <span className="tabular-nums text-white/35">
                      {cards.filter((card) => card.category === value).length}
                    </span>
                  </button>
                ))}
              </nav>

              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <input
                  type="search"
                  autoFocus
                  aria-label={t('previz.motion.library.search')}
                  placeholder={t('previz.motion.library.search')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none placeholder:text-white/30 focus:border-white/25"
                />
                {showImportBar && (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className={SECONDARY}
                      disabled={room <= 0 || importState.phase === 'reading'}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {t('previz.motion.import.button')}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".glb,.gltf,.bvh"
                      aria-label={t('previz.motion.import.button')}
                      className="hidden"
                      onChange={(event) => void chooseFile(event)}
                    />
                    {room <= 0 && (
                      <span className="text-[12px] text-white/45">
                        {t('previz.motion.import.limit', { max: PREVIZ_MOTION_LIMITS.imported })}
                      </span>
                    )}
                    {importState.phase === 'reading' && (
                      <span role="status" className="text-[12px] text-white/45">
                        {t('previz.motion.import.reading')}
                      </span>
                    )}
                    {importState.phase === 'idle' && importState.error && (
                      <span role="alert" className="min-w-0 truncate text-[12px] text-[#ff7875]">
                        {motionErrorText(t, importState.error)}
                      </span>
                    )}
                  </div>
                )}
                {matches.length > 0 ? (
                  <ul
                    aria-label={t('previz.motion.library.list')}
                    className="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(128px,1fr))] content-start gap-2 overflow-y-auto"
                  >
                    {matches.map((card) => {
                      const importedId = importedIdOf(card.id);
                      const status = importedId === null ? undefined : motionStatus[importedId];
                      if (importedId !== null && renaming?.id === importedId) {
                        return (
                          <li key={card.id} className="rounded-lg border border-[#3fae5f] p-2">
                            <input
                              type="text"
                              autoFocus
                              aria-label={t('previz.motion.import.name')}
                              value={renaming.name}
                              onChange={(event) => setRenaming({ id: importedId, name: event.target.value })}
                              onBlur={finishRename}
                              onKeyDown={(event) => {
                                // 不让 Enter / Esc 冒到编辑器：那边的 Esc 会把整个预演台关掉。
                                if (event.key === 'Enter') {
                                  event.stopPropagation();
                                  finishRename();
                                } else if (event.key === 'Escape') {
                                  event.stopPropagation();
                                  setRenaming(null);
                                }
                              }}
                              className="h-7 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none"
                            />
                          </li>
                        );
                      }
                      return (
                        <li key={card.id} className="group relative">
                          <button
                            type="button"
                            aria-pressed={card.id === selected}
                            className={CARD}
                            onClick={() => {
                              setSelected(card.id);
                              setRejected(null);
                            }}
                          >
                            <span className="w-full truncate pr-10 text-[12px]">{card.name}</span>
                            <span className="flex w-full items-center justify-between text-[11px] text-white/35">
                              <span className="tabular-nums">
                                {t('previz.motion.seconds', { value: card.durationSec.toFixed(1) })}
                              </span>
                              <span>{t(card.loop ? 'previz.motion.loop' : 'previz.motion.once')}</span>
                            </span>
                            {status?.state === 'error' && (
                              <span className="w-full text-[11px] text-[#ff7875]">
                                {motionErrorText(t, status.error)}
                              </span>
                            )}
                          </button>
                          {importedId !== null && (
                            <span className="absolute right-1 top-1 flex opacity-60 group-hover:opacity-100">
                              <button
                                type="button"
                                className={STEP_BUTTON}
                                aria-label={t('previz.motion.import.rename')}
                                onClick={() => setRenaming({ id: importedId, name: card.name })}
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                className={STEP_BUTTON}
                                aria-label={t('previz.motion.import.remove')}
                                onClick={() => setRemovingId(importedId)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="py-10 text-center text-[12px] text-white/40">
                    {t(showImportBar ? 'previz.motion.import.empty' : 'previz.motion.library.empty')}
                  </p>
                )}
              </div>

              <div className="flex w-[230px] shrink-0 flex-col gap-2">
                {picked ? (
                  <canvas
                    ref={canvasRef}
                    aria-label={t('previz.motion.library.preview')}
                    width={PREVIZ_CHARACTER_PREVIEW_SIZE.width}
                    height={PREVIZ_CHARACTER_PREVIEW_SIZE.height}
                    className="h-[415px] w-[230px] rounded-md border border-white/10 bg-black"
                  />
                ) : (
                  <p className="flex h-[415px] items-center justify-center rounded-md border border-dashed border-white/10 text-[12px] text-white/40">
                    {t('previz.motion.library.pickHint')}
                  </p>
                )}
              </div>
            </div>

            <footer className="flex items-center justify-end gap-3 border-t border-white/10 pt-3">
              {reason && (
                <p role="status" className="min-w-0 flex-1 truncate text-[12px] text-[#ff7875]">
                  {t(`previz.motion.library.reject.${reason}`, { max: PREVIZ_MOTION_LIMITS.clipsPerCharacter })}
                </p>
              )}
              <button type="button" className={PRIMARY} disabled={!canConfirm} onClick={confirm}>
                {t(request.mode === 'add' ? 'previz.motion.library.confirmAdd' : 'previz.motion.library.confirmReplace')}
              </button>
            </footer>
          </>
        )}

        {removing && (
          <div
            role="alertdialog"
            aria-label={t('previz.motion.import.removeTitle', { name: removing.name })}
            className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50"
          >
            <div className="flex w-72 flex-col gap-3 rounded-lg border border-white/10 bg-[#1b1e24] p-4">
              <p className="text-[13px] text-white/90">
                {t('previz.motion.import.removeTitle', { name: removing.name })}
              </p>
              {actionClipsUsing(scene, removing.id) > 0 && (
                <p className="text-[12px] text-white/60">
                  {t('previz.motion.import.removeUsed', { count: actionClipsUsing(scene, removing.id) })}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className={SECONDARY} onClick={() => setRemovingId(null)}>
                  {t('previz.motion.import.cancel')}
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md bg-[#d9363e] px-4 text-[12px] font-medium text-white hover:bg-[#e5484f]"
                  onClick={() => {
                    onRemoveMotion(removing.id);
                    if (selected === importMotionRef(removing.id)) setSelected(null);
                    setRemovingId(null);
                  }}
                >
                  {t('previz.motion.import.removeConfirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
