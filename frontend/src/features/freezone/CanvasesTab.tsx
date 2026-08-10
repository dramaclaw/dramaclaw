// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
    const ok = window.confirm(t("freezone.canvases.restoreConfirm"));
    if (!ok) return;
    setRestoringMainline(true);
    try {
      await onRestoreMainlineDefault();
    } finally {
      setRestoringMainline(false);
    }
  };

  const sections = buildCanvasBrowserSections(items, currentCanvasId, username);
  // 一条横向 tab 条：我的画布在最前，其余按最近修改排在后面。
  const canvasTabs = flattenCanvasBrowserSections(sections);
  const showRestoreMainlineAction = currentCanvasId !== "default" && hasPresetLabel;

  const handleRestoreMainlineClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void handleRestoreMainline();
  };

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

      {loading ? (
        <div className="shrink-0 px-3 py-4 text-center text-xs text-text-muted">
          {t("freezone.canvases.loading")}
        </div>
      ) : (
        <CanvasTabStrip
          items={canvasTabs}
          currentCanvasId={currentCanvasId}
          showRestoreMainlineAction={showRestoreMainlineAction}
          restoringMainline={restoringMainline}
          deletingCanvasId={deletingCanvasId}
          username={username}
          creating={showCreateForm}
          onToggleCreate={() => setShowCreateForm((value) => !value)}
          onSwitch={switchTo}
          onRestoreMainline={handleRestoreMainlineClick}
          onDelete={handleDeleteCanvas}
        />
      )}

      {/* 新建表单默认收起，点 tab 行末尾的 + 才展开 */}
      {showCreateForm && (
        <form onSubmit={handleCreateCanvas} className="shrink-0 px-3 pb-2 pt-2">
          <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] p-1.5">
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
          </div>
        </form>
      )}

      {/* 画布条以下是当前画布的节点大纲 */}
      <CanvasOutlineList collapsed={collapsed} />
    </div>
  );
}

function CanvasTabStrip({
  items,
  currentCanvasId,
  showRestoreMainlineAction,
  restoringMainline,
  deletingCanvasId,
  username,
  creating,
  onToggleCreate,
  onSwitch,
  onRestoreMainline,
  onDelete,
}: {
  items: CanvasDisplaySummary[];
  currentCanvasId: string;
  showRestoreMainlineAction: boolean;
  restoringMainline: boolean;
  deletingCanvasId: string | null;
  username?: string | null;
  creating: boolean;
  onToggleCreate: () => void;
  onSwitch: (id: string) => void;
  onRestoreMainline: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onDelete: (item: CanvasDisplaySummary) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [edgeFade, setEdgeFade] = useState({ start: false, end: false });

  // 切换画布后把选中的 tab 滚进可视区，避免它停在滚动条外面。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentCanvasId, items.length]);

  // 只有真的滚得动时才给边缘上渐隐，免得刚好放得下的时候把末尾那个 tab 也蒙灰。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const sync = () => {
      const max = element.scrollWidth - element.clientWidth;
      setEdgeFade({ start: element.scrollLeft > 1, end: element.scrollLeft < max - 1 });
    };
    sync();
    element.addEventListener("scroll", sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [items.length]);

  const fadeMask = edgeFadeMask(edgeFade.start, edgeFade.end);

  // 普通滚轮（只有 deltaY）也能横向翻这条 tab。
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!element) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    element.scrollLeft += event.deltaY;
  };

  const currentItem = items.find((item) => item.id === currentCanvasId) ?? null;
  const currentSourceCanvasId = currentItem ? sourceCanvasIdFromSummary(currentItem) : null;
  const canRestoreMainline = showRestoreMainlineAction && !!currentItem;
  const showSourceShortcut =
    !!currentSourceCanvasId && currentSourceCanvasId !== currentCanvasId;

  return (
    <Tabs
      value={currentCanvasId}
      // 切换只由 trigger 的 onClick 驱动：受控 value 不让组件自己改，
      // 否则 base-ui 内部的激活会顺手把当前画布带走。
      onValueChange={noop}
      className="shrink-0 gap-0 px-3 pt-2.5"
    >
      {/* 整行共用一条基线，选中 tab 的下划线正好压在上面 */}
      <div className="flex items-center gap-1 border-b border-white/[0.07]">
        <div
          ref={scrollRef}
          onWheel={handleWheel}
          style={fadeMask ? { maskImage: fadeMask, WebkitMaskImage: fadeMask } : undefined}
          className="ui-scrollbar-hidden min-w-0 flex-1 overflow-x-auto"
        >
          <TabsList variant="line" className="gap-0 p-0">
            {items.map((item) => (
              <CanvasTab
                key={item.id}
                ref={item.id === currentCanvasId ? activeRef : undefined}
                item={item}
                isCurrent={item.id === currentCanvasId}
                canDelete={canDeleteCanvasSummary(item, username)}
                deleting={deletingCanvasId === item.id}
                onSwitch={onSwitch}
                onDelete={onDelete}
              />
            ))}
          </TabsList>
        </div>

        {/* 当前画布的操作固定在右侧，不跟着 tab 一起滚走 */}
        {showSourceShortcut && (
          <button
            type="button"
            onClick={() => onSwitch(currentSourceCanvasId)}
            title={t("freezone.canvases.sourceCanvasTitle", { canvasId: currentSourceCanvasId })}
            className="mb-1 inline-flex h-5 shrink-0 items-center rounded-full border border-amber-300/35 px-2 text-[10px] text-amber-200 transition hover:bg-amber-300/15 hover:text-amber-100"
          >
            {t("freezone.canvases.sourceCanvas")}
          </button>
        )}
        {canRestoreMainline && (
          <button
            type="button"
            onClick={onRestoreMainline}
            disabled={restoringMainline}
            className="mb-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/45 transition hover:bg-white/[0.07] hover:text-white disabled:cursor-default disabled:opacity-50"
            title={t("freezone.canvases.restoreTitle")}
            aria-label={restoringMainline ? t("freezone.canvases.restoreBusy") : t("freezone.canvases.restore")}
          >
            <RotateCcw className={"h-3.5 w-3.5 " + (restoringMainline ? "animate-spin" : "")} />
          </button>
        )}
        {/* 分隔一下，别让 + 看起来像是最后一个 tab 的关闭按钮 */}
        <span aria-hidden className="mb-1 ml-0.5 h-3.5 w-px shrink-0 bg-white/10" />
        <button
          type="button"
          onClick={onToggleCreate}
          aria-expanded={creating}
          className={
            "mb-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition " +
            (creating
              ? "bg-white/[0.09] text-white"
              : "text-white/45 hover:bg-white/[0.07] hover:text-white")
          }
          title={t("freezone.canvases.createTitle")}
          aria-label={t("freezone.canvases.createTitle")}
        >
          {creating ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        </button>
      </div>
    </Tabs>
  );
}

function noop() {}

/** 两端各渐隐 18px，提示这条 tab 还能往那个方向滚。 */
function edgeFadeMask(start: boolean, end: boolean): string | undefined {
  if (!start && !end) return undefined;
  const stops = [
    start ? "transparent 0, #000 18px" : "#000 0",
    end ? "#000 calc(100% - 18px), transparent 100%" : "#000 100%",
  ];
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function CanvasTab({
  ref,
  item,
  isCurrent,
  canDelete,
  deleting,
  onSwitch,
  onDelete,
}: {
  ref?: React.Ref<HTMLDivElement>;
  item: CanvasDisplaySummary;
  isCurrent: boolean;
  canDelete: boolean;
  deleting: boolean;
  onSwitch: (id: string) => void;
  onDelete: (item: CanvasDisplaySummary) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const summary =
    item.displayKind === "personal" && item.displayName === PERSONAL_CANVAS_DISPLAY_NAME
      ? t("freezone.canvases.personalCanvasName")
      : displayNameForCanvasSummary(item, t);
  const relative = formatRelative(item.modified_at, t);

  return (
    <div ref={ref} className="group relative flex h-full shrink-0 items-stretch">
      <TabsTrigger
        value={item.id}
        onClick={() => onSwitch(item.id)}
        title={`${summary} · ${relative} · ${(item.size / 1024).toFixed(1)} KB`}
        // after:bottom-0 让下划线落在整行的基线上，而不是浮在下面 5px
        className={
          "h-full rounded-none px-2.5 text-[11px] group-data-horizontal/tabs:after:bottom-0 " +
          (canDelete ? "pr-6" : "")
        }
      >
        <span className="max-w-[112px] truncate">{summary}</span>
      </TabsTrigger>
      {canDelete && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void onDelete(item);
          }}
          disabled={deleting}
          className={
            "absolute right-1 top-1/2 inline-flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-white/40 transition hover:bg-red-500/15 hover:text-red-200 focus-visible:opacity-100 disabled:opacity-50 " +
            (isCurrent ? "" : "opacity-0 group-hover:opacity-100")
          }
          title={t("freezone.canvases.deleteTitle")}
          aria-label={deleting ? t("freezone.canvases.deleteBusy") : t("freezone.canvases.delete")}
        >
          {deleting ? <Trash2 className="h-3 w-3" /> : <X className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
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
