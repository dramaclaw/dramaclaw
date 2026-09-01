// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId } from "react";
import {
  Box,
  Camera,
  Eye,
  EyeOff,
  Lightbulb,
  Lock,
  LockOpen,
  Monitor,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { PrevizObject, PrevizObjectKind } from "@/features/previz/domain/scene";
import { cn } from "@/lib/utils";

/**
 * Record 而不是 Partial：新增对象类型时这里编译期报错，不会静默塌成一个通用图标。
 * 与 `PrevizToolbar` 的 `KIND_ICON` 是同一套图标——两个面板指着同一个对象却画不同的
 * 符号，比多维护一份常量贵得多。没有抽成共享常量是因为工具栏只需要四个创建按钮的
 * 图标、图层面板还要五个状态图标，抽出去的是一个只有两个消费者的四行对象。
 */
const KIND_ICON: Record<PrevizObjectKind, LucideIcon> = {
  character: User,
  camera: Camera,
  light: Lightbulb,
  prop: Box,
};

/** 分组顺序与工具栏的创建按钮顺序一致，用户在两处看到的是同一个次序。 */
const KIND_ORDER: readonly PrevizObjectKind[] = ["character", "camera", "light", "prop"];

export interface PrevizLayerPanelProps {
  objects: readonly PrevizObject[];
  selectedId: string | null;
  activeCameraId: string | null;
  onSelect: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onToggleLocked: (id: string) => void;
  onRemove: (id: string) => void;
  /** 传 null 表示关掉监看。 */
  onSetActiveCamera: (id: string | null) => void;
}

const ROW_BUTTON = "text-white/55 hover:bg-white/10 hover:text-white";

export function PrevizLayerPanel({
  objects,
  selectedId,
  activeCameraId,
  onSelect,
  onToggleVisible,
  onToggleLocked,
  onRemove,
  onSetActiveCamera,
}: PrevizLayerPanelProps) {
  const { t } = useTranslation();
  const idPrefix = useId();

  const panelClass = "flex w-64 shrink-0 flex-col border-l border-white/10 bg-black/30";

  if (objects.length === 0) {
    return (
      <div className={cn(panelClass, "items-center justify-center px-4 text-center text-[12px] text-white/45")}>
        {t("previz.layers.empty")}
      </div>
    );
  }

  const titleId = `${idPrefix}-title`;

  return (
    <div className={cn(panelClass, "overflow-y-auto py-2")}>
      <div id={titleId} className="px-3 pb-1 text-[11px] uppercase tracking-wide text-white/40">
        {t("previz.layers.title")}
      </div>
      {/*
        role="listbox" 不只是装饰：`aria-selected` 只有落在 option 上才有意义，没有
        listbox 父级的裸 option 对读屏是个孤儿角色。分组用 role="group"，它是 listbox
        合法的中间层。
      */}
      <div role="listbox" aria-labelledby={titleId} className="flex flex-col">
        {KIND_ORDER.map((kind) => {
          const group = objects.filter((object) => object.kind === kind);
          if (group.length === 0) return null;
          const headingId = `${idPrefix}-${kind}`;
          const Icon = KIND_ICON[kind];

          return (
            <div key={kind} role="group" aria-labelledby={headingId}>
              {/* 分组名只写一遍：可见标题即 group 的无障碍名，不再挂一份 aria-label。 */}
              <div id={headingId} className="px-3 pt-2 pb-1 text-[11px] text-white/35">
                {t(`previz.layers.kind.${kind}`)}
              </div>

              {group.map((object) => {
                const selected = object.id === selectedId;
                const monitoring = object.id === activeCameraId;

                return (
                  <div
                    key={object.id}
                    data-testid={`previz-layer-${object.id}`}
                    role="option"
                    aria-selected={selected}
                    tabIndex={0}
                    onClick={() => onSelect(object.id)}
                    onKeyDown={(event) => {
                      // 只认落在行本身的按键。行里还有四个按钮，用空格激活「隐藏」时
                      // keydown 会一路冒泡上来，不挡的话一次按键既切了可见性又选了行——
                      // 鼠标那条路径靠按钮的 stopPropagation 挡住了，键盘这条没有。
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        // 空格默认会滚动页面，而这一行本身就在一个可滚动的列表里。
                        event.preventDefault();
                        onSelect(object.id);
                      }
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-1 px-3 py-1 text-[13px]",
                      selected ? "bg-white/[0.10] text-white" : "text-white/75 hover:bg-white/[0.05]",
                    )}
                  >
                    <Icon
                      data-testid={`previz-layer-icon-${object.id}`}
                      className="h-3.5 w-3.5 shrink-0 text-white/45"
                    />
                    <span className="flex-1 truncate" title={object.name}>
                      {object.name}
                    </span>

                    {object.kind === "camera" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className={cn(ROW_BUTTON, monitoring && "text-sky-300 hover:text-sky-200")}
                        aria-label={t("previz.layers.setActiveCamera")}
                        aria-pressed={monitoring}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSetActiveCamera(monitoring ? null : object.id);
                        }}
                      >
                        <Monitor className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={ROW_BUTTON}
                      aria-label={t("previz.layers.toggleVisible")}
                      aria-pressed={object.visible}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleVisible(object.id);
                      }}
                    >
                      {object.visible ? (
                        <Eye className="h-3.5 w-3.5" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" />
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={ROW_BUTTON}
                      aria-label={t("previz.layers.toggleLocked")}
                      aria-pressed={object.locked}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleLocked(object.id);
                      }}
                    >
                      {object.locked ? (
                        <Lock className="h-3.5 w-3.5" />
                      ) : (
                        <LockOpen className="h-3.5 w-3.5" />
                      )}
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={cn(ROW_BUTTON, "hover:text-red-300")}
                      aria-label={t("previz.layers.remove")}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(object.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
