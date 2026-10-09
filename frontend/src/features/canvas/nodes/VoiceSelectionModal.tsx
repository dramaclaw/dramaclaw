// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Search, X, AudioWaveform } from 'lucide-react';
import { toast } from 'sonner';

import type { AudioVoiceRef } from '@/features/canvas/domain/canvasNodes';
import {
  createFreezoneAudioVoice,
  fetchFreezoneAudioReferences,
  type FreezoneAudioReferenceItem,
} from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { CANVAS_NODE_INPUT_PLACEHOLDER_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

const PAGE_SIZE = 20;
// 后端 freezone-audio 支持的音频扩展（与 openapi 描述一致）。
// 既用作 <input accept> 的扩展白名单，也用作前端兜底校验，避免浏览器
// 把 accept="audio/*" 当成纯提示忽略掉、让用户选到视频/其它格式。
const ALLOWED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.webm',
] as const;
const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
] as const;
const ACCEPT_ATTRIBUTE = [
  ...ALLOWED_AUDIO_MIME_TYPES,
  ...ALLOWED_AUDIO_EXTENSIONS,
].join(',');

// 参考音频体积上限,与后端 freezone-audio 的 5MB 限制对齐
// (后端超限会返回 {code:"freezone_audio_voice_too_large", limit:5242880})。
// 必须前端先卡:超限的 body 仍会被发出去,后端读不完整个 body 就提前回包 +
// 关连接,浏览器在「请求体还没传完」时遇到连接关闭会直接判定为网络错误、
// 丢弃那条 200 的友好提示,用户只看到一句没头没尾的 network error。前置校验
// 让超大文件根本不发请求,避开这个时序坑。
const MAX_VOICE_FILE_BYTES = 5_242_880; // 5MB
const MAX_VOICE_FILE_MB = 5;

function isAllowedAudioFile(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  const hasAllowedExt = ALLOWED_AUDIO_EXTENSIONS.some((ext) =>
    lowerName.endsWith(ext),
  );
  if (!hasAllowedExt) return false;
  // MIME 不可靠（有时为空、有时是 video/webm 这种）：扩展名通过后，再用
  // MIME 做兜底——若浏览器给了 video/* 这种明确错的类型，仍然拒绝。
  if (file.type && file.type.startsWith('video/')) return false;
  return true;
}

type TabId = 'library' | 'mine';

export interface VoicePickResult {
  ref: AudioVoiceRef;
  label: string;
  language?: string;
}

interface VoiceSelectionModalProps {
  open: boolean;
  onClose: () => void;
  currentRef: AudioVoiceRef;
  onPick: (result: VoicePickResult) => void;
  initialTab?: TabId;
}

export function VoiceSelectionModal({
  open,
  onClose,
  currentRef,
  onPick,
  initialTab = 'library',
}: VoiceSelectionModalProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>('library');
  const [items, setItems] = useState<FreezoneAudioReferenceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const project = readUrl().project;
    if (!project) {
      setError(t('node.voiceModal.missingProject'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFreezoneAudioReferences(project);
      setItems(res.available ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('node.voiceModal.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时拉一次（音色库 + 我的音色共享同一份 references 数据）
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    void reload();
  }, [initialTab, open, reload]);

  // 音色库 = available 完整字段；我的音色 = available 里 scope=user_custom 的子集。
  const libraryItems = items;
  const myItems = useMemo(
    () => items.filter((it) => it.scope === 'user_custom'),
    [items],
  );

  if (!open) return null;

  const content = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[620px] max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[10px] border border-white/[0.14] bg-[#141518]/96 shadow-[0_18px_48px_rgba(0,0,0,0.48)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-[15px] font-semibold text-text-dark">
            {t('node.voiceModal.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-dark/70 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
            title={t('node.voiceModal.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <TabsRow tab={tab} onChange={setTab} />

        {tab === 'library' ? (
          <LibraryTab
            currentRef={currentRef}
            onPick={onPick}
            items={libraryItems}
            loading={loading}
            error={error}
          />
        ) : (
          <MyVoicesTab
            currentRef={currentRef}
            onPick={onPick}
            items={myItems}
            loading={loading}
            error={error}
            onReload={reload}
          />
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

interface TabsRowProps {
  tab: TabId;
  onChange: (tab: TabId) => void;
}

function TabsRow({ tab, onChange }: TabsRowProps) {
  const { t } = useTranslation();
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'library', label: t('node.voiceModal.tab.library') },
    { id: 'mine', label: t('node.voiceModal.tab.mine') },
  ];
  return (
    <div className="flex items-center gap-2 px-5">
      {tabs.map((t) => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className={`h-8 rounded-full px-3.5 text-[13px] font-medium transition-colors ${
              active
                ? 'bg-[rgb(var(--accent-rgb))]/18 text-[rgb(var(--accent-rgb))]'
                : 'text-text-muted/90 hover:bg-white/[0.06] hover:text-text-dark'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 音色库 tab — 调 references 接口，客户端搜索 + 分页
// ---------------------------------------------------------------------------

interface LibraryTabProps {
  currentRef: AudioVoiceRef;
  onPick: (result: VoicePickResult) => void;
  items: FreezoneAudioReferenceItem[];
  loading: boolean;
  error: string | null;
}

function LibraryTab({ currentRef, onPick, items, loading, error }: LibraryTabProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const fields = [
        item.label ?? '',
        item.character_name ?? '',
        item.identity_id ?? '',
        item.slot ?? '',
        item.language ?? '',
      ];
      return fields.some((s) => String(s).toLowerCase().includes(q));
    });
  }, [items, query]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const currentKey = voiceRefKey(currentRef);

  return (
    <>
      <ToolbarRow>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('node.voiceModal.searchLibrary')}
        />
      </ToolbarRow>

      <ListBody>
        {loading && (
          <CenteredHint>
            <Loader2 className="h-4 w-4 animate-spin" /> {t('node.voiceModal.loading')}
          </CenteredHint>
        )}
        {!loading && error && (
          <CenteredHint className="text-rose-400">{error}</CenteredHint>
        )}
        {!loading && !error && total === 0 && (
          <CenteredHint>{t('node.voiceModal.empty')}</CenteredHint>
        )}
        {!loading &&
          !error &&
          pageItems.map((item, idx) => {
            // voiceId 必须带上 —— user_custom scope 全靠它区分，漏了的话
            // 同一 scope 的多条 ref 会撞同一个 key（参考 voiceRefKey），
            // 列表里所有用户音色都会被错误地标成"已选"。
            const ref: AudioVoiceRef = {
              scope: item.scope,
              characterName: item.character_name ?? undefined,
              identityId: item.identity_id ?? undefined,
              slot: item.slot ?? undefined,
              voiceId: item.voice_id ?? undefined,
            };
            const key = voiceRefKey(ref);
            const isActive = key === currentKey;
            return (
              <VoiceRow
                key={`${key}-${idx}`}
                title={item.label ?? describeVoiceRef(ref, t)}
                language={item.language ?? null}
                gender={readGender(item)}
                isActive={isActive}
                onSelect={() =>
                  onPick({
                    ref,
                    label: item.label ?? describeVoiceRef(ref, t),
                    language: item.language ?? undefined,
                  })
                }
              />
            );
          })}
      </ListBody>

      <FooterPagination
        page={safePage}
        totalPages={totalPages}
        total={total}
        onChange={setPage}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 我的音色 tab — 列表 + 上传
// ---------------------------------------------------------------------------

interface MyVoicesTabProps {
  currentRef: AudioVoiceRef;
  onPick: (result: VoicePickResult) => void;
  items: FreezoneAudioReferenceItem[];
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void>;
}

function MyVoicesTab({
  currentRef,
  onPick,
  items,
  loading,
  error,
  onReload,
}: MyVoicesTabProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClone = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // 复位 input，使得连续上传同一文件也能触发 change
      e.target.value = '';
      if (!file) return;
      if (!isAllowedAudioFile(file)) {
        toast.error(t('node.voiceModal.pickAudioFile'));
        return;
      }
      if (file.size > MAX_VOICE_FILE_BYTES) {
        const gotMb = (file.size / 1024 / 1024).toFixed(1);
        toast.error(
          t('node.voiceModal.fileTooLarge', { limit: MAX_VOICE_FILE_MB, size: gotMb }),
        );
        return;
      }
      const project = readUrl().project;
      if (!project) {
        toast.error(t('node.voiceModal.missingProject'));
        return;
      }
      setUploading(true);
      try {
        // 文件名（去扩展名）作为默认音色名，避免空字符串。
        const stem = file.name.replace(/\.[^/.]+$/, '');
        await createFreezoneAudioVoice(project, file, stem || undefined);
        await onReload();
      } catch (err) {
        const raw = err instanceof Error ? err.message : '';
        // ky 的 NetworkError 文案是英文原文（"Request failed due to a network
        // error: ..."）。多数情况是文件偏大导致连接被提前关闭,给一句可读提示。
        const friendly = /network error/i.test(raw)
          ? t('node.voiceModal.uploadNetworkError', { limit: MAX_VOICE_FILE_MB })
          : raw || t('node.voiceModal.uploadFailed');
        toast.error(friendly);
      } finally {
        setUploading(false);
      }
    },
    [onReload, t],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const fields = [
        item.label ?? '',
        item.voice_id ?? '',
        item.language ?? '',
      ];
      return fields.some((s) => String(s).toLowerCase().includes(q));
    });
  }, [items, query]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const currentKey = voiceRefKey(currentRef);

  return (
    <>
      <ToolbarRow>
        <button
          type="button"
          onClick={handleClone}
          disabled={uploading}
          className="inline-flex h-9 items-center gap-1 rounded-full border border-[rgb(var(--accent-rgb))]/35 bg-[rgb(var(--accent-rgb))]/12 px-3.5 text-[13px] font-medium text-[rgb(var(--accent-rgb))] transition-colors hover:bg-[rgb(var(--accent-rgb))]/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {uploading ? t('node.voiceModal.uploading') : t('node.voiceModal.clone')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={handleFileChange}
        />
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={t('node.voiceModal.searchMine')}
        />
      </ToolbarRow>

      <ListBody>
        {loading && (
          <CenteredHint>
            <Loader2 className="h-4 w-4 animate-spin" /> {t('node.voiceModal.loading')}
          </CenteredHint>
        )}
        {!loading && error && (
          <CenteredHint className="text-rose-400">{error}</CenteredHint>
        )}
        {!loading && !error && total === 0 && (
          <EmptyState onClone={handleClone} />
        )}
        {!loading &&
          !error &&
          pageItems.map((item, idx) => {
            const voiceId = item.voice_id ?? '';
            const ref: AudioVoiceRef = {
              scope: 'user_custom',
              voiceId: voiceId || undefined,
            };
            const key = voiceRefKey(ref);
            const isActive = key === currentKey;
            const label = item.label ?? voiceId ?? t('node.voiceRef.userCustom');
            return (
              <VoiceRow
                key={voiceId ? `${voiceId}` : `mine-${idx}`}
                title={label}
                language={item.language ?? null}
                gender={readGender(item)}
                isActive={isActive}
                onSelect={() =>
                  onPick({
                    ref,
                    label,
                    language: item.language ?? undefined,
                  })
                }
              />
            );
          })}
      </ListBody>

      {total > 0 && (
        <FooterPagination
          page={safePage}
          totalPages={totalPages}
          total={total}
          onChange={setPage}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 共用：toolbar / list / row / pagination
// ---------------------------------------------------------------------------

function ToolbarRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-5 pb-3 pt-4">{children}</div>
  );
}

interface SearchBoxProps {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}

function SearchBox({ value, onChange, placeholder }: SearchBoxProps) {
  return (
    <div className="relative flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted/90" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-9 w-full rounded-full border border-white/[0.1] bg-transparent pl-9 pr-3 text-[13px] text-text-dark outline-none transition-colors hover:border-white/[0.14] focus:border-white/20 ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
      />
    </div>
  );
}

function ListBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="ui-scrollbar flex-1 overflow-y-auto px-5 pb-2">
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function CenteredHint({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-center gap-2 py-12 text-[13px] text-text-muted ${
        className ?? ''
      }`}
    >
      {children}
    </div>
  );
}

interface VoiceRowProps {
  title: string;
  language: string | null;
  gender: string | null;
  isActive: boolean;
  onSelect: () => void;
}

function VoiceRow({ title, language, gender, isActive, onSelect }: VoiceRowProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-[52px] items-center gap-3 rounded-[10px] border border-white/[0.06] bg-white/[0.035] px-3 transition-colors hover:border-white/[0.1] hover:bg-white/[0.055]">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-white/[0.06]">
        <AudioWaveform className="h-4 w-4 text-text-muted/90" />
      </div>
      <div className="min-w-0 flex-1 truncate text-[14px] font-medium text-text-dark">
        {title}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-text-muted">
        {language && (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5">{language}</span>
        )}
        {gender && (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5">{gender}</span>
        )}
      </div>
      <button
        type="button"
        onClick={onSelect}
        disabled={isActive}
        className={`ml-1 inline-flex h-7 shrink-0 items-center justify-center rounded-full px-4 text-[12px] font-medium transition-colors ${
          isActive
            ? 'cursor-default bg-white/[0.08] text-text-muted'
            : 'bg-[rgb(var(--accent-rgb))] text-bg-dark hover:bg-[rgb(var(--accent-rgb))]/90'
        }`}
      >
        {isActive ? t('node.voiceModal.selected') : t('node.voiceModal.select')}
      </button>
    </div>
  );
}

function EmptyState({ onClone }: { onClone: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-[13px] text-text-muted">
      <div className="flex h-16 w-20 items-center justify-center rounded-md bg-white/[0.04]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="h-8 w-8 text-text-muted/70"
        >
          <path
            d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <span>{t('node.voiceModal.emptyMine')}</span>
      <button
        type="button"
        onClick={onClone}
        className="inline-flex h-8 items-center gap-1 rounded-full border border-[rgb(var(--accent-rgb))]/35 bg-[rgb(var(--accent-rgb))]/12 px-3 text-[12px] font-medium text-[rgb(var(--accent-rgb))] transition-colors hover:bg-[rgb(var(--accent-rgb))]/20"
      >
        <Plus className="h-3 w-3" />
        {t('node.voiceModal.clone')}
      </button>
    </div>
  );
}

interface FooterPaginationProps {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}

function FooterPagination({
  page,
  totalPages,
  total,
  onChange,
}: FooterPaginationProps) {
  const { t } = useTranslation();
  if (total === 0) return null;
  const pages = paginationWindow(page, totalPages);
  return (
    <footer className="flex items-center justify-between px-5 py-3 text-[12px] text-text-muted">
      <div className="flex items-center gap-1">
        <PaginationButton
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          {'<'}
        </PaginationButton>
        {pages.map((p, idx) =>
          p === 'ellipsis' ? (
            <span key={`e-${idx}`} className="px-1 text-text-muted/70">
              …
            </span>
          ) : (
            <PaginationButton
              key={p}
              active={p === page}
              onClick={() => onChange(p)}
            >
              {p}
            </PaginationButton>
          ),
        )}
        <PaginationButton
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          {'>'}
        </PaginationButton>
        <span className="ml-3 inline-flex h-7 items-center rounded-full border border-white/[0.1] bg-transparent px-2.5 text-[12px] text-text-dark">
          {t('node.voiceModal.perPage', { count: PAGE_SIZE })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span>{t('node.voiceModal.jumpTo')}</span>
        <PaginationJump page={page} totalPages={totalPages} onChange={onChange} />
        <span>{t('node.voiceModal.pageSuffix')}</span>
        <span className="ml-3">{t('node.voiceModal.totalCount', { count: total })}</span>
      </div>
    </footer>
  );
}

function PaginationButton({
  children,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 min-w-[28px] items-center justify-center rounded-full px-1.5 text-[12px] transition-colors ${
        active
          ? 'bg-[rgb(var(--accent-rgb))]/18 text-[rgb(var(--accent-rgb))]'
          : 'text-text-dark/85 hover:bg-white/[0.06] hover:text-text-dark'
      } ${disabled ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : ''}`}
    >
      {children}
    </button>
  );
}

function PaginationJump({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const [value, setValue] = useState('');
  const commit = () => {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    const target = Math.max(1, Math.min(totalPages, Math.trunc(n)));
    onChange(target);
    setValue('');
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      onBlur={commit}
      placeholder={String(page)}
      className="h-7 w-12 rounded-full border border-white/[0.1] bg-transparent px-2 text-center text-[12px] text-text-dark outline-none focus:border-white/20"
    />
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function paginationWindow(
  page: number,
  totalPages: number,
): Array<number | 'ellipsis'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out: Array<number | 'ellipsis'> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) out.push('ellipsis');
  for (let p = start; p <= end; p += 1) out.push(p);
  if (end < totalPages - 1) out.push('ellipsis');
  out.push(totalPages);
  return out;
}

function voiceRefKey(ref: AudioVoiceRef): string {
  return [
    ref.scope,
    ref.characterName ?? '',
    ref.identityId ?? '',
    ref.slot ?? '',
    ref.voiceId ?? '',
  ].join('|');
}

function describeVoiceRef(ref: AudioVoiceRef, t: TFunction): string {
  switch (ref.scope) {
    case 'project_narrator':
      return t('node.voiceRef.projectNarrator');
    case 'user_custom':
      return ref.voiceId ?? t('node.voiceRef.userCustom');
    case 'character_default':
      return t('node.voiceRef.characterDefault', {
        name: ref.characterName ?? t('node.voiceRef.character'),
      });
    case 'character_age_group':
      return t('node.voiceRef.characterAgeGroup', {
        name: ref.characterName ?? t('node.voiceRef.character'),
        slot: ref.slot ?? t('node.voiceRef.ageGroup'),
      });
    case 'identity':
      return t('node.voiceRef.identity', {
        id: ref.identityId ?? t('node.voiceRef.identityFallback'),
      });
    case 'identity_resolved':
      return t('node.voiceRef.identityResolved', {
        id: ref.identityId ?? t('node.voiceRef.identityFallback'),
      });
    default:
      return ref.scope;
  }
}

function readGender(item: FreezoneAudioReferenceItem): string | null {
  const raw =
    (item as Record<string, unknown>).gender ??
    (item as Record<string, unknown>).sex;
  if (typeof raw === 'string' && raw.trim()) return raw;
  return null;
}
