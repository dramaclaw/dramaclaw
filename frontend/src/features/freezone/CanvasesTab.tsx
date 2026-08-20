// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, CornerUpLeft, Plus, RotateCcw, Trash2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmDialog } from "@/components/confirm-dialog-host";
import { CanvasOutlineList } from "./CanvasOutlineList";
import {
  createBlankFreezoneCanvas,
  deleteFreezoneCanvas,
  type FreezoneCanvasSummary,
} from "@/api/canvas";
import { ApiError } from "@/api/client";
import { writeUrl } from "@/lib/url-params";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { personalCanvasIdForUsername } from "@/features/freezone/projections";
import { useFreezoneCanvases } from "@/lib/queries/freezone";
import { BackendStatusError } from "@/lib/api-errors";

const PERSONAL_CANVAS_DISPLAY_NAME = "__personal_canvas__";

interface CanvasesTabProps {
  project: string;
  currentCanvasId: string;
  /**
   * Refresh the current preset/mainline canvas in place. The shell exposes
   * this via `useCanvasSync.restoreMainlineDefault`; we only show the button
   * when the current canvas is a preset/mainline canvas (`hasPresetLabel`).
   */
  onRestoreMainlineDefault?: () => Promise<void> | void;
  hasPresetLabel: boolean;
  reloadToken?: number;
  /**
   * 抽屉是否处于收起态。收起走的是 CSS `-translate-x-full`，组件并不卸载，
   * 所以要显式往下传，让大纲停掉它那条按 nodes 重算的订阅（见 CanvasOutlineList）。
   */
  collapsed?: boolean;
}

export function CanvasesTab({
  project,
  currentCanvasId,
  onRestoreMainlineDefault,
  hasPresetLabel,
  reloadToken,
  collapsed = false,
}: CanvasesTabProps) {
  const { t } = useTranslation();
  const username = useAuthStore((state) => state.username);
  const canvasesQuery = useFreezoneCanvases(project);
  const [deletedCanvasIds, setDeletedCanvasIds] = useState<Set<string>>(() => new Set());
  const items = (canvasesQuery.data ?? []).filter((item) => !deletedCanvasIds.has(item.id));
  const loading = canvasesQuery.isLoading;
  const queryError = canvasesQuery.error;
  const [localError, setLocalError] = useState<string | null>(null);
  const [deletingCanvasId, setDeletingCanvasId] = useState<string | null>(null);
  const [creatingCanvas, setCreatingCanvas] = useState(false);
  const [newCanvasName, setNewCanvasName] = useState("");
  const [restoringMainline, setRestoringMainline] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);
  const reloadKey = `${reloadToken ?? 0}`;
  const previousReloadKeyRef = useRef(reloadKey);

  useEffect(() => {
    if (showCreateForm) createInputRef.current?.focus();
  }, [showCreateForm]);

  const closeCreateForm = () => {
    setShowCreateForm(false);
    setNewCanvasName("");
    setLocalError(null);
  };

  useEffect(() => {
    if (previousReloadKeyRef.current === reloadKey) return;
    previousReloadKeyRef.current = reloadKey;
    void canvasesQuery.refetch();
  }, [canvasesQuery, reloadKey]);

  const error = localError ?? (queryError instanceof Error ? queryError.message : queryError ? String(queryError) : null);

  const switchTo = (id: string) => {
    if (id === currentCanvasId) return;
    writeUrl({ canvas: id });
  };

  const handleRestoreMainline = async () => {
    if (!onRestoreMainlineDefault) return;
    // 走统一的确认框而不是 window.confirm：原生弹窗在这套深色 UI 里是块白板，
    // 而且这个动作会重建 preset 层，值得让人看清楚自己在同意什么。
    const ok = await confirmDialog({
      title: t("freezone.canvases.restoreMenu"),
      description: t("freezone.canvases.restoreConfirm"),
      confirmText: t("freezone.canvases.restore"),
    });
    if (!ok) return;
    setRestoringMainline(true);
    try {
      await onRestoreMainlineDefault();
    } finally {
      setRestoringMainline(false);
    }
  };

  const sections = buildCanvasBrowserSections(items, currentCanvasId, username);
  // 下拉里的一条列表：我的画布在最前，其余按最近修改排在后面。
  const canvasOptions = flattenCanvasBrowserSections(sections);
  const showRestoreMainlineAction = currentCanvasId !== "default" && hasPresetLabel;

  const handleCreateCanvas = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newCanvasName.trim();
    if (!name) {
      setLocalError(t("freezone.canvases.createNameRequired"));
      return;
    }
    const duplicate = findDuplicateCanvasName(items, name, t);
    if (duplicate) {
      setLocalError(t("freezone.canvases.createDuplicate", { name }));
      return;
    }
    const canvasId = userCreatedCanvasId(name, username);
    if (items.some((item) => item.id === canvasId)) {
      setLocalError(t("freezone.canvases.createDuplicate", { name }));
      return;
    }
    setCreatingCanvas(true);
    setLocalError(null);
    try {
      await createBlankFreezoneCanvas(project, {
        canvasId,
        name,
        creatorUsername: username,
      });
      setDeletedCanvasIds((prev) => {
        if (!prev.has(canvasId)) return prev;
        const next = new Set(prev);
        next.delete(canvasId);
        return next;
      });
      setNewCanvasName("");
      setShowCreateForm(false);
      await canvasesQuery.refetch();
      writeUrl({ canvas: canvasId });
    } catch (err) {
      if (isConflictError(err)) {
        setLocalError(t("freezone.canvases.createDuplicate", { name }));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(t("freezone.canvases.createFailed", { message }));
    } finally {
      setCreatingCanvas(false);
    }
  };

  const handleDeleteCanvas = async (item: CanvasDisplaySummary) => {
    if (!canDeleteCanvasSummary(item, username)) return;
    const name = displayNameForCanvasSummary(item, t);
    const ok = await confirmDialog({
      title: t("freezone.canvases.deleteTitle"),
      description: t("freezone.canvases.deleteConfirm", { name }),
      confirmText: t("common.delete"),
      confirmVariant: "destructive",
    });
    if (!ok) return;
    setDeletingCanvasId(item.id);
    setLocalError(null);
    try {
      await deleteFreezoneCanvas(project, item.id);
      setDeletedCanvasIds((prev) => new Set(prev).add(item.id));
      await canvasesQuery.refetch();
      if (item.id === currentCanvasId) {
        writeUrl({ canvas: username ? personalCanvasIdForUsername(username) : "default" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(t("freezone.canvases.deleteFailed", { message }));
    } finally {
      setDeletingCanvasId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="px-3 pb-2 pt-3">
          <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
            {error}
          </div>
        </div>
      )}

      {/* 新建表单默认收起，从画布选择器的菜单里点「新建项目画布」才展开 */}
      {showCreateForm && (
        <form onSubmit={handleCreateCanvas} className="shrink-0 px-3 pb-1 pt-2.5">
          <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] p-1.5">
            <input
              ref={createInputRef}
              value={newCanvasName}
              onChange={(event) => {
                setNewCanvasName(event.target.value);
                if (localError) setLocalError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeCreateForm();
              }}
              maxLength={40}
              placeholder={t("freezone.canvases.createPlaceholder")}
              disabled={creatingCanvas}
              className="h-6 min-w-0 flex-1 bg-transparent px-1 text-xs text-white/82 outline-none placeholder:text-white/34 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={creatingCanvas || !newCanvasName.trim()}
              className="inline-flex h-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.045] px-2 text-[11px] font-medium text-white/72 transition hover:border-white/18 hover:bg-white/[0.075] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
              title={t("freezone.canvases.createTitle")}
            >
              {creatingCanvas ? t("freezone.canvases.createBusy") : t("freezone.canvases.create")}
            </button>
            {/* 表单是从菜单里开出来的，关它得有个自己的出口——原来那个 + 按钮已经不在了 */}
            <button
              type="button"
              onClick={closeCreateForm}
              disabled={creatingCanvas}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/45 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-45"
              title={t("common.cancel")}
              aria-label={t("common.cancel")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>
      )}

      {/* 画布选择器直接坐进大纲的工具栏，原来那条独立的横向 tab 整行省掉 */}
      <CanvasOutlineList
        collapsed={collapsed}
        leading={
          <CanvasSelect
            items={canvasOptions}
            currentCanvasId={currentCanvasId}
            loading={loading}
            username={username}
            restoringMainline={restoringMainline}
            deletingCanvasId={deletingCanvasId}
            canRestoreMainline={showRestoreMainlineAction}
            onSwitch={switchTo}
            onCreate={() => setShowCreateForm(true)}
            onRestoreMainline={() => void handleRestoreMainline()}
            onDelete={handleDeleteCanvas}
          />
        }
      />
    </div>
  );
}

const CANVAS_MENU_CONTENT_CLASS =
  "z-[120] max-h-[320px] min-w-[212px] max-w-[280px] overflow-y-auto border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";
const CANVAS_MENU_ITEM_CLASS =
  "gap-2 rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark";
const CANVAS_MENU_RADIO_CLASS =
  "rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark";

/**
 * 画布选择器。原来这里是一条横向 tab 条，自己占满一行。
 * 但侧栏顶上本来就有面板 tab 和大纲工具栏两条横杠，中间再夹一条同款的，
 * 三层看下来分不清谁管谁；而画布一次只可能激活一个，排成并列的 tab 是把
 * 「单选」画成了「多开」。收成下拉挂进大纲工具栏：省一整行，当前画布的名字
 * 反而成了这块面板最显眼的字。
 */
function CanvasSelect({
  items,
  currentCanvasId,
  loading,
  username,
  restoringMainline,
  deletingCanvasId,
  canRestoreMainline,
  onSwitch,
  onCreate,
  onRestoreMainline,
  onDelete,
}: {
  items: CanvasDisplaySummary[];
  currentCanvasId: string;
  loading: boolean;
  username?: string | null;
  restoringMainline: boolean;
  deletingCanvasId: string | null;
  canRestoreMainline: boolean;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRestoreMainline: () => void;
  onDelete: (item: CanvasDisplaySummary) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 菜单关闭时 base-ui 会把焦点抢回触发按钮，确认框要是这会儿开就会跟它抢一轮，
  // 所以会弹窗的那两个动作先记下来，等菜单彻底关干净再跑。
  const pendingRef = useRef<(() => void) | null>(null);

  const currentItem = items.find((item) => item.id === currentCanvasId) ?? null;
  const currentSourceCanvasId = currentItem ? sourceCanvasIdFromSummary(currentItem) : null;
  const showSourceShortcut = !!currentSourceCanvasId && currentSourceCanvasId !== currentCanvasId;
  const showRestore = canRestoreMainline && !!currentItem;
  const canDeleteCurrent = !!currentItem && canDeleteCanvasSummary(currentItem, username);
  const deletingCurrent = deletingCanvasId === currentCanvasId;
  const label = currentItem
    ? canvasSelectLabel(currentItem, t)
    : loading
      ? t("freezone.canvases.loading")
      : currentCanvasId;
  // 同步/删除都是点完菜单就关，转圈要是画在菜单里就等于没画。
  // 顶掉触发器上的那个箭头：位置一样大，行内一格都不用动。
  const busy = restoringMainline || deletingCurrent;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen) return;
        const action = pendingRef.current;
        pendingRef.current = null;
        action?.();
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            title={label}
            aria-label={t("freezone.canvases.switcher")}
            aria-busy={busy}
            className="-ml-1 inline-flex h-6 min-w-0 max-w-[168px] items-center gap-1 rounded-md px-1.5 text-xs font-medium text-text-dark transition hover:bg-[rgb(var(--text-rgb)/0.07)]"
          />
        }
      >
        <span className="truncate">{label}</span>
        {busy ? (
          <RotateCcw className="h-3 w-3 shrink-0 animate-spin text-text-muted" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className={CANVAS_MENU_CONTENT_CLASS} align="start">
        <DropdownMenuRadioGroup value={currentCanvasId} onValueChange={onSwitch}>
          {items.map((item) => (
            <DropdownMenuRadioItem
              key={item.id}
              value={item.id}
              // base-ui 的单选项默认不关菜单，选完就该收起来
              closeOnClick
              className={CANVAS_MENU_RADIO_CLASS}
            >
              <span className="min-w-0 truncate">{canvasSelectLabel(item, t)}</span>
              {/* 同名画布不少（同一条主线的副本），靠这个时间戳分辨哪张是刚动过的 */}
              {item.modified_at && (
                <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-text-muted/70">
                  {formatRelative(item.modified_at, t)}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator className="bg-[var(--ui-border-soft)]" />

        <DropdownMenuItem className={CANVAS_MENU_ITEM_CLASS} onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          <span>{t("freezone.canvases.createTitle")}</span>
        </DropdownMenuItem>
        {showSourceShortcut && (
          <DropdownMenuItem
            className={CANVAS_MENU_ITEM_CLASS}
            onClick={() => onSwitch(currentSourceCanvasId)}
          >
            <CornerUpLeft className="h-3.5 w-3.5" />
            <span>{t("freezone.canvases.backToSource")}</span>
          </DropdownMenuItem>
        )}
        {showRestore && (
          <DropdownMenuItem
            className={CANVAS_MENU_ITEM_CLASS}
            disabled={restoringMainline}
            onClick={() => {
              pendingRef.current = onRestoreMainline;
            }}
          >
            <RotateCcw className={"h-3.5 w-3.5 " + (restoringMainline ? "animate-spin" : "")} />
            <span>
              {restoringMainline
                ? t("freezone.canvases.restoreBusy")
                : t("freezone.canvases.restoreMenu")}
            </span>
          </DropdownMenuItem>
        )}
        {canDeleteCurrent && (
          <DropdownMenuItem
            variant="destructive"
            className={CANVAS_MENU_ITEM_CLASS}
            disabled={deletingCurrent}
            onClick={() => {
              pendingRef.current = () => void onDelete(currentItem);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>
              {deletingCurrent
                ? t("freezone.canvases.deleteBusy")
                : t("freezone.canvases.deleteCurrent")}
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 「我的画布」那条在数据里存的是占位串，落到界面上得换成人话。 */
function canvasSelectLabel(item: CanvasDisplaySummary, t: Translate): string {
  return item.displayKind === "personal" && item.displayName === PERSONAL_CANVAS_DISPLAY_NAME
    ? t("freezone.canvases.personalCanvasName")
    : displayNameForCanvasSummary(item, t);
}

type CanvasDisplaySummary = FreezoneCanvasSummary & {
  displayName?: string;
  displayKind?: CanvasKind;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface CanvasBrowserSections {
  defaultCanvas: CanvasDisplaySummary;
  memberCanvases: CanvasDisplaySummary[];
  otherCanvases: CanvasDisplaySummary[];
}

export function buildCanvasBrowserSections(
  items: FreezoneCanvasSummary[],
  _currentCanvasId: string,
  username?: string | null,
): CanvasBrowserSections {
  const personalCanvasId = username ? personalCanvasIdForUsername(username) : null;
  const existingPersonal = personalCanvasId
    ? items.find((item) => item.id === personalCanvasId)
    : undefined;
  const defaultCanvas: CanvasDisplaySummary =
    username && personalCanvasId
      ? {
          ...(existingPersonal ?? { id: personalCanvasId, modified_at: "", size: 0 }),
          displayName: username,
          displayKind: "personal",
        }
      : items.find((it) => canvasKindFromSummary(it) === "default") ?? {
          id: "default",
          modified_at: "",
          size: 0,
        };
  const visibleItems = items.filter((item) => item.id !== defaultCanvas.id);
  const memberCanvases: CanvasDisplaySummary[] = [];
  const otherCanvases: CanvasDisplaySummary[] = [];

  for (const item of visibleItems) {
    if (isPersonalCanvasForAnyUser(item)) {
      memberCanvases.push({ ...item, displayKind: "personal" });
      continue;
    }
    if (isUserCreatedCanvas(item)) {
      memberCanvases.push(item);
      continue;
    }
    otherCanvases.push(item);
  }

  return {
    defaultCanvas,
    memberCanvases: memberCanvases.sort(compareCanvasSummaryByRecent),
    otherCanvases: otherCanvases.sort(compareCanvasSummaryByRecent),
  };
}

/** 把分组结果压成一条：我的画布在最前，成员画布、其他画布依次跟随，同 id 只保留一次。 */
export function flattenCanvasBrowserSections(
  sections: CanvasBrowserSections,
): CanvasDisplaySummary[] {
  return [
    sections.defaultCanvas,
    ...sections.memberCanvases,
    ...sections.otherCanvases,
  ].filter((item, index, array) => array.findIndex((candidate) => candidate.id === item.id) === index);
}

export function orderCanvasSummaries(
  items: FreezoneCanvasSummary[],
  currentCanvasId: string,
): FreezoneCanvasSummary[] {
  const sections = buildCanvasBrowserSections(items, currentCanvasId);
  return [
    sections.defaultCanvas,
    ...sections.memberCanvases,
    ...sections.otherCanvases,
  ].filter((item, index, array) => array.findIndex((candidate) => candidate.id === item.id) === index);
}

export function isEpisodeSectionExpandedByDefault({
  episode,
  currentEpisode,
}: {
  episode: number;
  currentEpisode: number | null;
}): boolean {
  return currentEpisode !== null && episode === currentEpisode;
}

function compareCanvasSummaryByRecent(a: FreezoneCanvasSummary, b: FreezoneCanvasSummary): number {
  return timestampOf(b.modified_at) - timestampOf(a.modified_at) || a.id.localeCompare(b.id);
}

function isPersonalCanvasForAnyUser(item: FreezoneCanvasSummary): boolean {
  if (isConflictCopyCanvas(item)) return false;
  return /^user_[a-z0-9_-]+_[a-z0-9]+$/.test(item.id);
}

function isConflictCopyCanvas(item: FreezoneCanvasSummary): boolean {
  return item.metadata?.canvas_origin === "conflict_copy" || item.id.startsWith("copy_") || item.id.includes("_copy_");
}

function isUserCreatedCanvas(item: FreezoneCanvasSummary): boolean {
  return item.metadata?.canvas_origin === "user_created";
}

function isConflictError(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 409) ||
    (error instanceof BackendStatusError && error.status === 409)
  );
}

export function canDeleteCanvasSummary(
  item: FreezoneCanvasSummary,
  username?: string | null,
): boolean {
  const personalCanvasId = username ? personalCanvasIdForUsername(username) : null;
  if (personalCanvasId && item.id === personalCanvasId) return false;
  if (isPersonalCanvasForAnyUser(item)) return false;
  return true;
}

function timestampOf(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

type CanvasKind =
  | "default"
  | "episode"
  | "beat"
  | "personal"
  | "asset"
  | "workflow"
  | "blank"
  | "other";

export function canvasKindFromSummary(item: FreezoneCanvasSummary): CanvasKind {
  const displayKind = (item as CanvasDisplaySummary).displayKind;
  if (displayKind) return displayKind;
  if (isUserCreatedCanvas(item)) return "blank";
  const metadata = item.metadata ?? {};
  if (metadata.free_workflow && typeof metadata.free_workflow === "object") {
    return "workflow";
  }
  const preset = metadata.preset as { scope?: unknown } | undefined;
  const scope =
    typeof item.canvas_scope === "string"
      ? item.canvas_scope
      : typeof preset?.scope === "string"
        ? preset.scope
        : item.id === "default"
          ? "default"
          : "";
  if (scope === "default") return "default";
  if (scope === "episode") return "episode";
  if (scope === "beat") return "beat";
  if (scope === "asset") return "asset";
  if (scope === "blank") return "blank";
  return "other";
}

function sourceCanvasIdFromSummary(item: FreezoneCanvasSummary): string | null {
  const freeWorkflow = item.metadata?.free_workflow;
  if (!freeWorkflow || typeof freeWorkflow !== "object") return null;
  const sourceCanvasId = (freeWorkflow as { source_canvas_id?: unknown }).source_canvas_id;
  return typeof sourceCanvasId === "string" && sourceCanvasId.trim().length > 0
    ? sourceCanvasId
    : null;
}

function metadataString(item: FreezoneCanvasSummary, key: string): string | null {
  const value = item.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function rawDisplayNameFromSummary(item: FreezoneCanvasSummary): string | null {
  return metadataString(item, "display_name");
}

function creatorUsernameFromSummary(item: FreezoneCanvasSummary): string | null {
  return metadataString(item, "creator_username");
}

function displayNameForCanvasSummary(item: CanvasDisplaySummary, t: Translate): string {
  const rawDisplayName = rawDisplayNameFromSummary(item);
  if (rawDisplayName) {
    const creator = creatorUsernameFromSummary(item);
    return creator ? t("freezone.canvases.userCreatedName", { user: creator, name: rawDisplayName }) : rawDisplayName;
  }
  return item.displayName ?? describeCanvasSummary(item, t);
}

function normalizeCanvasName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function compareCanvasName(item: FreezoneCanvasSummary, name: string, t: Translate): boolean {
  const normalized = normalizeCanvasName(name);
  if (!normalized) return false;
  const rawDisplayName = rawDisplayNameFromSummary(item);
  if (rawDisplayName && normalizeCanvasName(rawDisplayName) === normalized) return true;
  return normalizeCanvasName(describeCanvasSummary(item, t)) === normalized;
}

export function findDuplicateCanvasName(
  items: FreezoneCanvasSummary[],
  name: string,
  t: Translate,
): FreezoneCanvasSummary | null {
  return items.find((item) => compareCanvasName(item, name, t)) ?? null;
}

export function userCreatedCanvasId(name: string, username?: string | null): string {
  const base = `${username?.trim() || "user"}:${name.trim()}`;
  const slug = name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "canvas";
  return `canvas_${slug}_${stableCanvasIdHash(base)}`.slice(0, 64).replace(/_+$/g, "");
}

function stableCanvasIdHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function describeCanvasSummary(item: FreezoneCanvasSummary, t: Translate): string {
  const metadata = item.metadata ?? {};
  if (isConflictCopyCanvas(item)) return t("freezone.canvases.conflictCopy");
  if (metadata.free_workflow && typeof metadata.free_workflow === "object") {
    const source = (metadata.free_workflow as { source_preset?: unknown }).source_preset as
      | { scope?: unknown; episode?: unknown; beat?: unknown; asset_kind?: unknown; asset_id?: unknown }
      | null
      | undefined;
    if (source?.scope === "beat") {
      return t("freezone.canvases.description.freeWorkflowBeat", {
        episode: source.episode ?? "?",
        beat: source.beat ?? "?",
      });
    }
    if (source?.scope === "asset") {
      return t("freezone.canvases.description.freeWorkflowAsset", {
        asset: source.asset_id ?? source.asset_kind ?? t("freezone.canvases.description.assetFallback"),
      });
    }
    return t("freezone.canvases.description.freeWorkflow");
  }
  const preset = metadata.preset as
    | {
        scope?: unknown;
        episode?: unknown;
        beat?: unknown;
        primary_slot?: unknown;
        asset_kind?: unknown;
        character?: unknown;
        identity_id?: unknown;
        asset_id?: unknown;
      }
    | undefined;
  const scope =
    typeof item.canvas_scope === "string"
      ? item.canvas_scope
      : typeof preset?.scope === "string"
        ? preset.scope
        : item.id === "default"
          ? "default"
          : "";

  if (scope === "default") return t("freezone.canvases.description.default");
  if (scope === "episode") {
    const episode =
      typeof item.episode === "number"
        ? item.episode
        : typeof preset?.episode === "number"
          ? preset.episode
          : null;
    return episode !== null
      ? t("freezone.canvases.description.episode", { episode })
      : t("freezone.canvases.description.episodeUnknown");
  }
  if (scope === "beat") {
    const episode =
      typeof item.episode === "number"
        ? item.episode
        : typeof preset?.episode === "number"
          ? preset.episode
          : null;
    const beat =
      typeof item.beat === "number"
        ? item.beat
        : typeof preset?.beat === "number"
          ? preset.beat
          : null;
    const slot = typeof preset?.primary_slot === "string" ? ` · ${preset.primary_slot}` : "";
    return t("freezone.canvases.description.beat", {
      episode: episode ?? "?",
      beat: beat ?? "?",
      slot,
    });
  }
  if (scope === "asset") {
    const kind =
      typeof preset?.asset_kind === "string"
        ? preset.asset_kind
        : t("freezone.canvases.description.assetFallback");
    const character = typeof preset?.character === "string" ? preset.character : "";
    const identityId = typeof preset?.identity_id === "string" ? preset.identity_id : "";
    const assetId = typeof preset?.asset_id === "string" ? preset.asset_id : "";
    const name = character || identityId || assetId;
    return name
      ? t("freezone.canvases.description.asset", { name, kind })
      : t("freezone.canvases.description.assetUnknown", { kind });
  }
  if (scope === "blank") return t("freezone.canvases.description.blank");
  return item.id;
}

function formatRelative(iso: string, t: Translate): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return iso;
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return t("freezone.canvases.relative.now");
  if (minutes < 60) return t("freezone.canvases.relative.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("freezone.canvases.relative.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("freezone.canvases.relative.days", { count: days });
  return iso.slice(0, 10);
}
