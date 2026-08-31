// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import {
  Clapperboard,
  FileText,
  Film,
  Globe,
  Image,
  LayoutGrid,
  Music,
  Orbit,
  Sparkles,
  Type,
  Upload,
  Video,
  type LucideIcon,
} from "lucide-react";

import {
  CANVAS_NODE_TYPES,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import { nodeCatalog } from "@/features/canvas/application/nodeCatalog";
import type { MenuIconKey } from "@/features/canvas/domain/nodeRegistry";

export const canvasMenuIconMap: Record<MenuIconKey, LucideIcon> = {
  upload: Upload,
  sparkles: Sparkles,
  layout: LayoutGrid,
  text: Type,
  video: Video,
  audio: Music,
  script: FileText,
  pano360: Globe,
  threeDWorld: Orbit,
  videoCompose: Film,
  previz: Clapperboard,
};

export const CANVAS_ADD_NODE_TYPES: readonly CanvasNodeType[] = [
  CANVAS_NODE_TYPES.textAnnotation,
  CANVAS_NODE_TYPES.beatContext,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.videoCompose,
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.script,
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.pano360Viewer,
  CANVAS_NODE_TYPES.threeDWorld,
  CANVAS_NODE_TYPES.previz,
];

export const CANVAS_MENU_ICON_CELL_CLASS =
  "flex min-w-[58px] max-w-[96px] flex-col items-center gap-1.5 rounded-xl px-2.5 py-2 text-center transition-colors";

export const CANVAS_MENU_ROW_CLASS =
  "flex w-full items-center gap-3 rounded-xl py-2 pl-[17px] pr-2 text-left transition-colors";

interface CanvasMenuSectionHeaderProps {
  label: string;
  className?: string;
}

export function CanvasMenuSectionHeader({
  label,
  className = "",
}: CanvasMenuSectionHeaderProps) {
  return (
    <div className={`text-[15px] font-semibold leading-none text-white/62 ${className}`}>
      {label}
    </div>
  );
}

interface CanvasAddNodeGridProps {
  onSelectNode: (type: CanvasNodeType, clientPosition?: { x: number; y: number }) => void;
  onItemPointerEnter?: () => void;
  transitionDelayForIndex?: (index: number) => string | undefined;
}

export function CanvasAddNodeGrid({
  onSelectNode,
  onItemPointerEnter,
  transitionDelayForIndex,
}: CanvasAddNodeGridProps) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-4 justify-items-center gap-x-2 gap-y-5">
      {CANVAS_ADD_NODE_TYPES.map((type, index) => {
        const definition = nodeCatalog.getDefinition(type);
        if (!definition) return null;
        const Icon = canvasMenuIconMap[definition.menuIcon] ?? Image;
        return (
          <button
            key={type}
            type="button"
            onMouseEnter={onItemPointerEnter}
            className={`${CANVAS_MENU_ICON_CELL_CLASS} hover:bg-white/[0.075]`}
            style={{ transitionDelay: transitionDelayForIndex?.(index) }}
            onClick={(event) => onSelectNode(type, { x: event.clientX, y: event.clientY })}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-300/[0.12]">
              <Icon className="h-4 w-4 text-cyan-200" />
            </div>
            <span className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-5 text-white/82">
              {t(definition.menuLabelKey)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
