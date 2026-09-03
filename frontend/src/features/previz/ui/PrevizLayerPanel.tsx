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

/**
 * 从图标表派生，而不是再手写一份字面量：手写数组没有穷尽性检查，新增一种对象时上面的
 * Record 会报错、数组却静默少一项，那一类的对象就整个不出现在图层面板里——选不中、
 * 删不掉，只能回场景 JSON 里找。`Object.keys` 对非整数字符串键保持书写顺序，所以上面
 * 的键序就是分组在屏幕上的顺序，与工具栏（同样从它的图标表派生）保持一致。
 */
const KIND_ORDER = Object.keys(KIND_ICON) as PrevizObjectKind[];

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

/**
 * 行内按钮统一走这里，`stopPropagation` 因此只写一遍：它挡的是「点按钮顺手把整行也选
 * 中了」——行本身有 onClick，按钮的 click 会冒泡上去。四个按钮各写一份的话，第五个按钮
 * 漏掉它就是一次没有编译期信号的静默回归。（键盘那条路另有守卫，见行的 onKeyDown：
 * 按钮上的空格先发一个冒泡的 keydown，click 要到 keyup 才来，stopPropagation 够不着。）
 */
function LayerRowButton({
  icon: Icon,
  label,
  pressed,
  className,
  onActivate,
}: {
  icon: LucideIcon;
  label: string;
  /** 省略即不是开关按钮（如「删除」），不渲染 aria-pressed。 */
  pressed?: boolean;
  className?: string;
  onActivate: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn("text-white/55 hover:bg-white/10 hover:text-white", className)}
      aria-label={label}
      aria-pressed={pressed}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}

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
                      // 只认落在行本身的按键。行里还有三四个按钮，用空格激活「隐藏」时
                      // keydown 会一路冒泡上来，不挡的话一次按键既切了可见性又选了行。
                      // 按钮的 stopPropagation 补不上这一枪：它挡的是 click，而按钮上的
                      // 空格要到 keyup 才合成 click，这个 keydown 早就冒泡完了。
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
                    {/*
                      人物图标涂成自己的辨识色：全场人物共用同一份角色模型，这一列图标
                      是名字之外唯一能一眼分清谁是谁的东西。另外三类没有辨识色，留在
                      原来那层灰上——`text-white/45` 只在没有内联色时才写，两者同时给会
                      让「灰」和「彩」谁赢取决于 Tailwind 的产出顺序。
                    */}
                    <Icon
                      data-testid={`previz-layer-icon-${object.id}`}
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        object.kind !== "character" && "text-white/45",
                      )}
                      style={object.kind === "character" ? { color: object.color } : undefined}
                    />
                    <span className="flex-1 truncate" title={object.name}>
                      {object.name}
                    </span>

                    {object.kind === "camera" && (
                      <LayerRowButton
                        icon={Monitor}
                        label={t("previz.layers.setActiveCamera")}
                        pressed={monitoring}
                        className={monitoring ? "text-sky-300 hover:text-sky-200" : undefined}
                        onActivate={() => onSetActiveCamera(monitoring ? null : object.id)}
                      />
                    )}

                    <LayerRowButton
                      icon={object.visible ? Eye : EyeOff}
                      label={t("previz.layers.toggleVisible")}
                      pressed={object.visible}
                      onActivate={() => onToggleVisible(object.id)}
                    />

                    <LayerRowButton
                      icon={object.locked ? Lock : LockOpen}
                      label={t("previz.layers.toggleLocked")}
                      pressed={object.locked}
                      onActivate={() => onToggleLocked(object.id)}
                    />

                    <LayerRowButton
                      icon={Trash2}
                      label={t("previz.layers.remove")}
                      className="hover:text-red-300"
                      onActivate={() => onRemove(object.id)}
                    />
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
