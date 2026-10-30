// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Boxes } from "lucide-react";
import { useTranslation } from "react-i18next";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function hasDirectorControlBundle(bundle: unknown): boolean {
  const record = recordValue(bundle);
  const relPaths = recordValue(record?.rel_paths);
  return (
    record?.schema_version === "director_control_bundle_v1" &&
    typeof relPaths?.combined === "string" &&
    typeof relPaths?.env_only === "string" &&
    typeof relPaths?.frame_meta === "string"
  );
}

export function DirectorControlBundleBadge({ bundle }: { bundle: unknown }) {
  const { t } = useTranslation();

  if (!hasDirectorControlBundle(bundle)) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute left-3 top-3 z-10 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-md border border-amber-200/40 bg-black/62 px-2 py-1 text-[11px] font-medium leading-none text-amber-100 shadow-[0_6px_18px_rgba(0,0,0,0.28)] backdrop-blur"
      title={t("node.directorControlBundle.tooltip")}
    >
      <Boxes className="size-3.5 shrink-0" />
      <span className="truncate">{t("node.directorControlBundle.badge")}</span>
    </div>
  );
}
