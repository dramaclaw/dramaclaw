// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, CornerUpLeft, Plus, RotateCcw, Trash2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { alertDialog, confirmDialog } from "@/components/confirm-dialog-host";
import { CanvasOutlineList } from "./CanvasOutlineList";
import {
  createBlankFreezoneCanvas,
  deleteFreezoneCanvas,
  generateClientSaveId,
  type FreezoneCanvasSummary,
} from "@/api/canvas";
import {
  canvasCreationQuota,
  canvasKindFromSummary,
  displayNameForCanvasSummary,
  isConflictCopyCanvas,
  isUserCreatedCanvas,
  planCanvasCreation,
  type CanvasQuotaStatus,
  type CanvasSummaryForDisplay,
  type CanvasTranslate,
} from "@/features/canvas/core/canvasCreation";
import { ApiError } from "@/api/client";
import { writeUrl } from "@/lib/url-params";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { personalCanvasIdForUsername } from "@/features/freezone/projections";
import { useFreezoneCanvases } from "@/lib/queries/freezone";
import { MAX_USER_CREATED_CANVASES_PER_PROJECT } from "@/lib/limits";
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
  const displayName = useAuthStore((state) => state.displayName);
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

  // 我自己在这个项目里建了几张、还能不能再建。上限是产品配额，后端不拦（见
  // lib/limits.ts），所以拦截只能落在这里。
  // 只有列表真的回来了才拿它算配额：`items` 在加载中是空数组，按它判定等于把
  // 「不知道」当成「还有余量」。
  // 刷新失败也算「不知道」：refetch() 不抛，失败后 React Query 留着上一份列表，
  // 拿它接着数，刚建成的那张就不在账上，下一张能照建。
  const canvasQuota = canvasCreationQuota(
    canvasesQuery.data && !canvasesQuery.isError ? items : undefined,
    username,
  ).status;

  const showCanvasQuotaNotice = (status: Exclude<CanvasQuotaStatus, "available">) =>
    void alertDialog(
      status === "reached"
        ? {
            title: t("freezone.canvases.createLimitTitle"),
            description: t("freezone.canvases.createLimitReached", {
              limit: MAX_USER_CREATED_CANVASES_PER_PROJECT,
            }),
          }
        : {
            title: t("freezone.canvases.createQuotaUnknownTitle"),
            description: t("freezone.canvases.createQuotaUnknown"),
          },
    );

  // 入口一直可点：置灰的菜单项只会让人反复点一个死掉的按钮，还得自己猜为什么。
  // 点的那一下把话说清楚，再决定要不要开新建表单。
  const handleRequestCreateForm = () => {
    if (canvasQuota !== "available") {
      showCanvasQuotaNotice(canvasQuota);
      return;
    }
    setShowCreateForm(true);
  };

  const sections = buildCanvasBrowserSections(
    items,
    currentCanvasId,
    username,
    displayName,
  );
  // 下拉里的一条列表：我的画布在最前，其余按最近修改排在后面。
  const canvasOptions = flattenCanvasBrowserSections(sections);
  const showRestoreMainlineAction = currentCanvasId !== "default" && hasPresetLabel;

  const handleCreateCanvas = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 表单可能是超限之前就开着的（别处又建了一张），提交这一下再兜一次。
    const requestId = generateClientSaveId();
    const plan = planCanvasCreation({
      projectId: project,
      name: newCanvasName,
      creatorUsername: username,
      canvases: canvasesQuery.data && !canvasesQuery.isError ? items : undefined,
      requestId,
      saveSource: "manual_save",
    }, { translate: t });
    if (plan.status === "rejected") {
      const rejection = plan.rejection;
      switch (rejection.code) {
        case "quota_unknown":
          showCanvasQuotaNotice("unknown");
          break;
        case "quota_reached":
          showCanvasQuotaNotice("reached");
          break;
        case "name_required":
          setLocalError(t("freezone.canvases.createNameRequired"));
          break;
        case "duplicate_name":
        case "id_taken":
          setLocalError(t("freezone.canvases.createDuplicate", { name: rejection.name }));
          break;
        default: {
          const exhaustive: never = rejection;
          return exhaustive;
        }
      }
      return;
    }
    const name = newCanvasName.trim();
    setCreatingCanvas(true);
    setLocalError(null);
    try {
      await createBlankFreezoneCanvas(project, plan.canvasId, plan.payload);
      setDeletedCanvasIds((prev) => {
        if (!prev.has(plan.canvasId)) return prev;
        const next = new Set(prev);
        next.delete(plan.canvasId);
        return next;
      });
      setNewCanvasName("");
      setShowCreateForm(false);
      await canvasesQuery.refetch();
      writeUrl({ canvas: plan.canvasId });
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
          <div className="flex items-center gap-1 rounded-[8px] border border-white/[0.08] bg-white/[0.03] p-1.5">
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
              className="inline-flex h-6 shrink-0 items-center justify-center px-2 text-[11px] font-medium text-white/72 transition-colors hover:text-primary disabled:cursor-not-allowed disabled:text-white/30"
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
            onCreate={handleRequestCreateForm}
            onRestoreMainline={() => void handleRestoreMainline()}
            onDelete={handleDeleteCanvas}
          />
        }
      />
    </div>
  );
}

const CANVAS_MENU_CONTENT_CLASS =
  "z-[120] flex max-h-[320px] min-w-[212px] max-w-[280px] flex-col overflow-y-hidden rounded-[12px] border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";
const CANVAS_MENU_ITEM_CLASS =
  "gap-2 rounded-[8px] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark";

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
  const label = currentItem
    ? canvasSelectLabel(currentItem, t)
    : loading
      ? t("freezone.canvases.loading")
      : currentCanvasId;
  // 同步/删除都是点完菜单就关，转圈要是画在菜单里就等于没画。
  // 顶掉触发器上的那个箭头：位置一样大，行内一格都不用动。
  const busy = restoringMainline || deletingCanvasId !== null;

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
        {/* 只让画布列表滚。整块菜单一起滚的话，画布一多，「新建 / 回到来源」就被推到
            滚动区末尾，每次要用都得先把列表拖到底。 */}
        <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          {items.map((item) => {
            const itemLabel = canvasSelectLabel(item, t);
            const selected = item.id === currentCanvasId;
            const canDelete = canDeleteCanvasSummary(item, username);
            const deleting = deletingCanvasId === item.id;

            return (
              <div key={item.id} className="group/canvas-row relative">
                <DropdownMenuItem
                  closeOnClick
                  onClick={() => onSwitch(item.id)}
                  className={`${CANVAS_MENU_ITEM_CLASS} min-h-8 pr-8 ${
                    selected ? "bg-primary/[0.10] focus:bg-primary/[0.14]" : ""
                  }`}
                >
                  <span className="min-w-0 truncate">{itemLabel}</span>
                  {/* 同名画布靠修改时间区分；选中勾与删除入口共用行尾位置。 */}
                  {item.modified_at && (
                    <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-text-muted/70">
                      {formatRelative(item.modified_at, t)}
                    </span>
                  )}
                  {selected && (
                    <Check
                      aria-hidden
                      className={`absolute right-2 h-3.5 w-3.5 text-primary transition-opacity ${
                        canDelete ? "group-hover/canvas-row:opacity-0 group-focus-within/canvas-row:opacity-0" : ""
                      }`}
                    />
                  )}
                </DropdownMenuItem>
                {canDelete && (
                  <button
                    type="button"
                    aria-label={`${t("common.delete")} ${itemLabel}`}
                    disabled={deleting}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      pendingRef.current = () => void onDelete(item);
                      setOpen(false);
                    }}
                    className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-text-muted opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/35 group-hover/canvas-row:opacity-100 disabled:pointer-events-none disabled:opacity-50"
                  >
                    {deleting ? (
                      <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="shrink-0">
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
        </div>
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

type CanvasDisplaySummary = CanvasSummaryForDisplay;

type Translate = CanvasTranslate;

interface CanvasBrowserSections {
  defaultCanvas: CanvasDisplaySummary;
  memberCanvases: CanvasDisplaySummary[];
  otherCanvases: CanvasDisplaySummary[];
}

export function buildCanvasBrowserSections(
  items: FreezoneCanvasSummary[],
  _currentCanvasId: string,
  username?: string | null,
  displayName?: string | null,
): CanvasBrowserSections {
  const personalCanvasId = username ? personalCanvasIdForUsername(username) : null;
  const existingPersonal = personalCanvasId
    ? items.find((item) => item.id === personalCanvasId)
    : undefined;
  const defaultCanvas: CanvasDisplaySummary =
    username && personalCanvasId
      ? {
          ...(existingPersonal ?? { id: personalCanvasId, modified_at: "", size: 0 }),
          displayName: displayName ?? username,
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

function sourceCanvasIdFromSummary(item: FreezoneCanvasSummary): string | null {
  const freeWorkflow = item.metadata?.free_workflow;
  if (!freeWorkflow || typeof freeWorkflow !== "object") return null;
  const sourceCanvasId = (freeWorkflow as { source_canvas_id?: unknown }).source_canvas_id;
  return typeof sourceCanvasId === "string" && sourceCanvasId.trim().length > 0
    ? sourceCanvasId
    : null;
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
