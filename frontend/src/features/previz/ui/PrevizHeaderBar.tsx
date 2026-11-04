// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { Circle, Redo2, Square, Undo2, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PrevizRecordMode } from "@/features/previz/capture/recordTarget";
import { PrevizHoverTip } from "@/features/previz/ui/PrevizHoverTip";
import { cn } from "@/lib/utils";

/**
 * 录制选单里的两项，顺序就是从左到右的顺序。写成 `readonly PrevizRecordMode[]` 而不是
 * 数组字面量推断：新增一种录制模式时这里不会静默少一项——类型对不上会在录制入口报错。
 */
const RECORD_MODES: readonly PrevizRecordMode[] = ["global", "track"];

export interface PrevizHeaderBarProps {
  canUndo: boolean;
  canRedo: boolean;
  /** 截图正在出片。出片期间录制也一并禁用，两条出片管线共用一张画布。 */
  capturing: boolean;
  /** 正在录制的模式；`null` 表示没在录。 */
  recording: PrevizRecordMode | null;
  /** 录制进度 0–1，写在停止键上。 */
  recordProgress: number;
  /** 录完之后的上传阶段：画面已经录好，节点还没接出来。 */
  recordPublishing: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onCapture: () => void;
  onRecord: (mode: PrevizRecordMode) => void;
  onStopRecord: () => void;
  onClose: () => void;
}

/** 顶栏上那颗只有图标的按钮（撤销、重做、关闭）。 */
function HeaderIconButton({
  icon: Icon,
  label,
  ...props
}: {
  icon: LucideIcon;
  label: string;
} & React.ComponentProps<typeof Button>) {
  return (
    <PrevizHoverTip label={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        // 禁用的原因只写在提示里，而 pointer-events: none 的元素连 hover 都收不到，
        // 用户就只剩一颗没有解释的灰按钮。原生 disabled 仍然拦着点击。
        className={cn(
          "h-8 w-8 text-white/75 hover:bg-white/10 hover:text-white",
          "disabled:pointer-events-auto disabled:cursor-not-allowed",
        )}
        {...props}
      >
        <Icon className="h-4 w-4" />
      </Button>
    </PrevizHoverTip>
  );
}

/** 顶栏右侧那两颗带文字的出片键（截图、录制）。 */
const ACTION_ITEM = "h-8 rounded-lg bg-white/10 px-3 text-[12px] text-white/85 hover:bg-white/20";

/**
 * 编辑器最上面那条横栏：左边是标题与撤销重做，右边是截图、录制与关闭。
 *
 * 这几样原先是浮在视口四角的绝对定位块。搬进独立的一条横栏，是因为它们全都**不是对着
 * 画面调画面**——截图和录制是把成果交出去，关闭是离开编辑器，撤销重做跟着 Ctrl+Z 的
 * 肌肉记忆走。浮在画面上时它们和真正需要贴着画面的那几簇（坐标轴小球、聚焦、显示模式、
 * 监看画中画）抢同一条顶边：录制选单一展开就盖住下面那排工具，放大后的监看框自己的开关
 * 也压在录制条底下。腾出这条横栏之后，视口顶边只剩「看着画面按」的那两簇，各自贴回自己
 * 的角，谁也不挡谁。
 */
export function PrevizHeaderBar({
  canUndo,
  canRedo,
  capturing,
  recording,
  recordProgress,
  recordPublishing,
  onUndo,
  onRedo,
  onCapture,
  onRecord,
  onStopRecord,
  onClose,
}: PrevizHeaderBarProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = capturing || recordPublishing;
  const recordLabel = recording
    ? t("previz.editor.record.stop")
    : t("previz.editor.record.open");

  return (
    <TooltipProvider delay={120}>
      {/*
        z-40 让整条横栏自成一个层叠上下文，盖过视口里那些 z-20 / z-30 的浮层：视口那层
        `position: relative` 的 z-index 是 auto，不建上下文，它的子元素是拿全局层级和这里
        比的。少了这一层，展开的录制选单会被视口右上角那簇显示模式盖掉一半。
      */}
      <div className="relative z-40 flex h-12 shrink-0 items-center justify-between gap-3
        border-b border-white/10 bg-[#15181d] px-3">
        <div className="flex items-center gap-1">
          {/*
            aria-hidden：DialogContent 里已经有一份 sr-only 的 DialogTitle 报同一个名字，
            两份都念出来的话读屏用户开局要听两遍「预演台」。
          */}
          <span aria-hidden className="px-2 text-[13px] font-medium text-white/85">
            {t("previz.editor.title")}
          </span>

          <div className="mx-1 h-5 w-px bg-white/10" />

          <HeaderIconButton
            icon={Undo2}
            label={t("previz.editor.undo")}
            disabled={!canUndo}
            onClick={onUndo}
          />
          <HeaderIconButton
            icon={Redo2}
            label={t("previz.editor.redo")}
            disabled={!canRedo}
            onClick={onRedo}
          />
        </div>

        {/*
          选单开着时铺一层透明背板：点界面任何地方都收起来。靠 onBlur 收的话，点选单里
          的按钮会先触发 blur、把自己卸掉，那一下就永远点不中。fixed 铺满而不是只盖视口，
          是为了连时间轴和右侧面板上的点击也算「点到别处」。
        */}
        {menuOpen && (
          <div
            data-testid="previz-record-backdrop"
            className="fixed inset-0 z-10"
            onPointerDown={() => setMenuOpen(false)}
          />
        )}

        <div className="flex items-center gap-2">
          {/*
            不挂 aria-label：这颗按钮的可见文字在出片时会变成「正在出片…」，而 aria-label
            会把可访问名字钉死在「截图出片」上——读屏用户于是听不见状态变化，只剩一颗
            按不动的按钮。让可见文字自己充当名字。
          */}
          <Button
            variant="ghost"
            disabled={busy || Boolean(recording)}
            className={ACTION_ITEM}
            onClick={onCapture}
          >
            {capturing ? t("previz.editor.capturing") : t("previz.editor.capture")}
          </Button>

          {/* z-20 把录制键连同它的选单抬到上面那层背板之上，否则点不中选单里的项。 */}
          <div className="relative z-20">
            <Button
              variant="ghost"
              aria-label={recordLabel}
              disabled={busy}
              className={ACTION_ITEM}
              onClick={() => {
                if (recording) {
                  onStopRecord();
                  return;
                }
                setMenuOpen((next) => !next);
              }}
            >
              {recording ? (
                <>
                  <Square className="mr-1 h-3 w-3 fill-current text-red-400" />
                  {t("previz.editor.record.stopWithProgress", {
                    percent: Math.round(recordProgress * 100),
                  })}
                </>
              ) : (
                <>
                  <Circle
                    className={cn(
                      "mr-1 h-3 w-3 fill-current",
                      recordPublishing ? "text-white/40" : "text-red-400",
                    )}
                  />
                  {recordPublishing
                    ? t("previz.editor.record.publishing")
                    : t("previz.editor.record.open")}
                </>
              )}
            </Button>

            {/*
              往左横着展开，不往下掉：录制键在最右边，正下方就是视口右上角那簇显示模式与
              重置视角，掉下去就盖住它们；而横栏中段是空的，选单摊在那儿谁也不碰。
            */}
            {menuOpen && !recording && (
              <div
                role="menu"
                aria-label={t("previz.editor.record.open")}
                aria-orientation="horizontal"
                className="absolute right-full top-0 mr-2 flex items-center gap-1 rounded-lg
                  border border-white/10 bg-[#181b20] p-1 whitespace-nowrap shadow-lg
                  shadow-black/60"
              >
                {RECORD_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="menuitem"
                    className="rounded-md px-3 py-1.5 text-[12px] text-white/85 transition
                      hover:bg-white/10 hover:text-white"
                    onClick={() => {
                      setMenuOpen(false);
                      onRecord(mode);
                    }}
                  >
                    {t(`previz.editor.record.mode.${mode}`)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <HeaderIconButton icon={X} label={t("previz.editor.close")} onClick={onClose} />
        </div>
      </div>
    </TooltipProvider>
  );
}
