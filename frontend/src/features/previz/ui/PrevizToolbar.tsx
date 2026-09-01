// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId } from "react";
import { Box, Camera, Lightbulb, Redo2, Undo2, Upload, User, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, buttonVariants } from "@/components/ui/button";
import { PREVIZ_OBJECT_LIMITS } from "@/features/previz/domain/limits";
import type { PrevizObjectKind } from "@/features/previz/domain/scene";
import { cn } from "@/lib/utils";

/** Record 而不是 Partial：新增对象类型时这里编译期报错，不会静默少一个按钮。 */
const KIND_ICON: Record<PrevizObjectKind, LucideIcon> = {
  character: User,
  camera: Camera,
  light: Lightbulb,
  prop: Box,
};

const KINDS: readonly PrevizObjectKind[] = ["character", "camera", "light", "prop"];

export interface PrevizToolbarProps {
  /** 每种对象是否还能再加（数量上限）。false 时按钮禁用而不是点了没反应。 */
  canAdd: Record<PrevizObjectKind, boolean>;
  canUndo: boolean;
  canRedo: boolean;
  onAdd: (kind: PrevizObjectKind) => void;
  onImportProp: (file: File) => void;
  onUndo: () => void;
  onRedo: () => void;
}

const RAIL_ITEM = "text-white/80 hover:bg-white/10 hover:text-white";

/**
 * `disabled:pointer-events-auto` 是故意覆盖 buttonVariants 的 `disabled:pointer-events-none`：
 * 禁用的原因只写在 `title` 里，而 pointer-events: none 的元素连原生 tooltip 都不会弹，
 * 用户就只剩一个没有解释的灰按钮。原生 `disabled` 仍然拦住点击，放开指针事件是安全的。
 */
const RAIL_BUTTON = cn(RAIL_ITEM, "disabled:pointer-events-auto disabled:cursor-not-allowed");

export function PrevizToolbar({
  canAdd,
  canUndo,
  canRedo,
  onAdd,
  onImportProp,
  onUndo,
  onRedo,
}: PrevizToolbarProps) {
  const { t } = useTranslation();
  const fileInputId = useId();

  return (
    <div className="flex w-14 flex-col items-center gap-2 border-r border-white/10 bg-black/30 py-3">
      {KINDS.map((kind) => {
        const Icon = KIND_ICON[kind];
        const addLabel = t(`previz.toolbar.add.${kind}`);
        return (
          <Button
            key={kind}
            type="button"
            variant="ghost"
            size="icon-lg"
            className={RAIL_BUTTON}
            disabled={!canAdd[kind]}
            aria-label={addLabel}
            title={
              canAdd[kind]
                ? addLabel
                : t("previz.toolbar.limitReached", { count: PREVIZ_OBJECT_LIMITS[kind] })
            }
            onClick={() => onAdd(kind)}
          >
            <Icon className="h-4 w-4" />
          </Button>
        );
      })}

      {/*
        input 是 `sr-only` 而不是 `hidden`：display:none 的控件拿不到焦点，键盘用户就
        再也够不着导入入口了。视觉上的按钮是它的 <label>，焦点环靠 peer-* 从 input 转过来。
        无障碍名字只由 <label> 里的 sr-only 文本提供——再挂一份 aria-label 是两处真相，
        改坏其中一处另一处会把问题遮住。
      */}
      <input
        id={fileInputId}
        type="file"
        accept=".glb,.gltf,.obj"
        className="peer sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onImportProp(file);
          // 清空 value：不清的话选同一个文件第二次不会触发 change。
          event.target.value = "";
        }}
      />
      <label
        htmlFor={fileInputId}
        title={t("previz.toolbar.importProp")}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-lg" }),
          RAIL_ITEM,
          "cursor-pointer peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
        )}
      >
        <Upload className="h-4 w-4" />
        <span className="sr-only">{t("previz.toolbar.importProp")}</span>
      </label>

      <div className="my-1 h-px w-8 bg-white/10" />

      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className={RAIL_BUTTON}
        disabled={!canUndo}
        aria-label={t("previz.toolbar.undo")}
        title={t("previz.toolbar.undo")}
        onClick={onUndo}
      >
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className={RAIL_BUTTON}
        disabled={!canRedo}
        aria-label={t("previz.toolbar.redo")}
        title={t("previz.toolbar.redo")}
        onClick={onRedo}
      >
        <Redo2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
