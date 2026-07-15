// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import {
  Edit3,
  ExternalLink,
  ImageIcon,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  Upload,
  X,
  Download,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { UsageCountBadge } from "@/components/assets/usage-count-badge";
import { ASSET_CARD_META_BADGE_CLASS } from "@/components/assets/asset-card-styles";
import { CopyAssetLinkButton } from "@/components/assets/copy-asset-link-button";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { resolveMediaUrl } from "@/lib/media-url";
import { sceneTypeLabel } from "@/lib/scene-type";
import { cn } from "@/lib/utils";
import type {
  SceneAsset,
  ScenePanoSource,
  SceneStage3gsFile,
  SceneStagePlySource,
} from "@/types/scene";

interface SceneAssetCardProps {
  scene: SceneAsset;
  referenceCount?: number;
  masterRunning?: boolean;
  reverseRunning?: boolean;
  panoRunning?: boolean;
  stageBusy?: boolean;
  masterPlyRunning?: boolean;
  reversePlyRunning?: boolean;
  panoPlyRunning?: boolean;
  masterCost?: string;
  reverseCost?: string;
  panoCost?: string;
  customUploading?: boolean;
  customDeleting?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onUploadMaster: () => void;
  onGenerateMaster: () => void;
  onDeleteMaster: () => void;
  onGenerateReverse: () => void;
  onUploadPano: () => void;
  onGeneratePano: (source: ScenePanoSource) => void;
  onDeletePano: () => void;
  onOpenPanoViewer?: () => void;
  onOpenStageViewer?: () => void;
  onOpenFreezone: () => void;
  freezonePending?: boolean;
  onUploadCustomPackage: () => void;
  onDeleteCustomPackage: () => void;
  onGenerateStagePly: (source: SceneStagePlySource) => void;
}

/** Image slot with label overlaid on top-left corner, optional action button on top-right */
function AssetImageSlot({
  label,
  src,
  emptyLabel,
  fit = "cover",
  actions,
  onPreview,
}: {
  label: string;
  src?: string | null;
  emptyLabel: string;
  fit?: "cover" | "contain";
  actions?: React.ReactNode;
  onPreview?: () => void;
}) {
  const resolved = resolveMediaUrl(src);
  return (
    <div className="min-w-0">
      <div className="relative aspect-video w-full overflow-hidden rounded-[8px] border border-border bg-black/20">
        {resolved ? (
          <>
            {/* Blurred background fill for contain mode */}
            {fit === "contain" && (
              <img
                src={resolved}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-md"
              />
            )}
            <button
              type="button"
              onClick={onPreview}
              disabled={!onPreview}
              className={cn(
                "relative z-10 block h-full w-full border-none bg-transparent p-0",
                onPreview ? "cursor-zoom-in" : "cursor-default",
              )}
            >
              <img
                src={resolved}
                alt={label}
                loading="lazy"
                decoding="async"
                className={cn(
                  "h-full w-full",
                  fit === "contain" ? "object-contain" : "object-cover",
                )}
              />
            </button>
          </>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageIcon className="size-5" />
            <span className="text-xs">{emptyLabel}</span>
          </div>
        )}
        {/* Overlay label */}
        <span className="absolute left-2 top-2 z-20 rounded-[6px] border border-white/10 bg-black/50 px-1.5 py-0.5 text-[11px] text-white/80 backdrop-blur-sm">
          {label}
        </span>
        {/* Top-right actions */}
        {actions && (
          <div className="absolute right-1.5 top-1.5 z-20 flex items-center gap-1">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

function StagePlyBadge({
  label,
  file,
}: {
  label: string;
  file: SceneStage3gsFile | undefined;
}) {
  if (!file?.ready) return null;
  return (
    <span className="rounded-[6px] border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
      {label}
    </span>
  );
}

export function SceneAssetCard({
  scene,
  referenceCount = 0,
  masterRunning = false,
  reverseRunning = false,
  panoRunning = false,
  stageBusy = false,
  masterPlyRunning = false,
  reversePlyRunning = false,
  panoPlyRunning = false,
  masterCost,
  reverseCost,
  panoCost,
  customUploading = false,
  customDeleting = false,
  onEdit,
  onDelete,
  onUploadMaster,
  onGenerateMaster,
  onDeleteMaster,
  onGenerateReverse,
  onUploadPano,
  onGeneratePano,
  onDeletePano,
  onOpenPanoViewer,
  onOpenStageViewer,
  onOpenFreezone,
  freezonePending = false,
  onUploadCustomPackage,
  onDeleteCustomPackage,
  onGenerateStagePly,
}: SceneAssetCardProps) {
  const { t } = useTranslation();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState("");
  const hasMaster = Boolean(resolveMediaUrl(scene.master_url));
  const hasReverse = Boolean(resolveMediaUrl(scene.reverse_master_url));
  const hasPano = Boolean(resolveMediaUrl(scene.pano_url));
  const description =
    scene.variant_prompt?.trim() ||
    scene.environment_prompt?.trim() ||
    scene.description?.trim() ||
    "";
  const derivedBase = scene.derived_from_scene?.trim() || "";
  const panoSource: ScenePanoSource = hasMaster ? "master" : "text";
  const panoGenerateLabel = hasMaster
    ? hasReverse
      ? t("assets.scenes.generatePanoFromMasterReverse")
      : t("assets.scenes.generatePanoFromMaster")
    : t("assets.scenes.generatePanoFromText");
  const stage = scene.stage_3gs;
  const canOpenStageViewer = Boolean(onOpenStageViewer);

  const masterResolved = resolveMediaUrl(scene.master_url);
  const reverseResolved = resolveMediaUrl(scene.reverse_master_url);
  const panoResolved = resolveMediaUrl(scene.pano_url);

  return (
    <>
      <Card size="sm" className="rounded-[10px] bg-white/[0.03] shadow-none">
        {/* Header: title + status chips inline, action icons on right */}
        <CardHeader className="gap-2">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <CardTitle className="truncate">{scene.name}</CardTitle>
              {/* Compact status chips inline with title */}
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {scene.scene_type && (
                  <span className={ASSET_CARD_META_BADGE_CLASS}>
                    {sceneTypeLabel(scene.scene_type)}
                  </span>
                )}
                {derivedBase && (
                  <span
                    className={cn(
                      ASSET_CARD_META_BADGE_CLASS,
                      "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                    )}
                  >
                    {t("assets.scenes.derivedFrom", { base: derivedBase })}
                  </span>
                )}
                <span className={ASSET_CARD_META_BADGE_CLASS}>
                  {t("assets.scenes.master")}{" "}
                  {hasMaster ? t("assets.common.generated") : t("assets.common.missing")}
                </span>
                <span className={ASSET_CARD_META_BADGE_CLASS}>
                  {t("assets.scenes.reverse")}{" "}
                  {hasReverse ? t("assets.common.generated") : t("assets.common.missing")}
                </span>
                <span className={ASSET_CARD_META_BADGE_CLASS}>
                  {t("assets.scenes.pano")}{" "}
                  {hasPano ? t("assets.common.generated") : t("assets.common.missing")}
                </span>
                <UsageCountBadge count={referenceCount} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <CopyAssetLinkButton type="scene" id={scene.name} />
              <button
                type="button"
                onClick={onOpenFreezone}
                disabled={freezonePending}
                aria-label={t("assets.scenes.openFreezone")}
                title={t("assets.scenes.openFreezoneTip")}
                className="flex size-[26px] items-center justify-center rounded-[8px] p-0 text-muted-foreground transition-all duration-150 hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {freezonePending ? (
                  <Loader2 className="size-[14px] animate-spin" />
                ) : (
                  <ExternalLink className="size-[14px]" />
                )}
              </button>
              <button
                type="button"
                onClick={onEdit}
                aria-label={t("assets.common.edit")}
                className="flex size-[26px] items-center justify-center rounded-[8px] p-0 text-muted-foreground transition-all duration-150 hover:bg-accent hover:text-foreground"
              >
                <Edit3 className="size-[14px]" />
              </button>
              <button
                type="button"
                onClick={onDelete}
                aria-label={t("assets.common.delete")}
                className="flex size-[26px] items-center justify-center rounded-[8px] p-0 text-muted-foreground transition-all duration-150 hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-[14px]" />
              </button>
            </div>
          </div>
          {description && (
            <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </CardHeader>

        {/* Image + actions merged into single columns */}
        <CardContent className="grid gap-4 pt-1 md:grid-cols-2 xl:grid-cols-3">
          {/* Master column */}
          <div className="flex flex-col gap-3">
            <AssetImageSlot
              label={t("assets.scenes.master")}
              src={scene.master_url}
              emptyLabel={t("assets.scenes.noMaster")}
              fit="cover"
              onPreview={masterResolved ? () => { setPreviewSrc(masterResolved); setPreviewLabel(t("assets.scenes.master")); } : undefined}
              actions={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); onDeleteMaster(); }}
                  disabled={!hasMaster}
                  aria-label={t("assets.scenes.deleteMaster")}
                  className="size-6 rounded-[4px] bg-black/50 p-0 text-white/70 hover:bg-destructive/30 hover:text-destructive backdrop-blur-sm"
                >
                  <Trash2 className="size-3" />
                </Button>
              }
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onUploadMaster}
                className="h-7 gap-1 rounded-[8px] px-2 text-xs active:scale-95 transition-transform"
              >
                <Upload className="size-3" />
                {t("assets.scenes.uploadMaster")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onGenerateMaster}
                disabled={masterRunning}
                className="h-7 gap-1 rounded-[8px] px-2 text-xs active:scale-95 transition-transform"
              >
                {masterRunning ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {hasMaster
                  ? t("assets.scenes.regenerateMaster")
                  : t("assets.scenes.generateMaster")}
                <CreditCostInline display={masterCost} />
              </Button>
            </div>
          </div>

          {/* Reverse column */}
          <div className="flex flex-col gap-3">
            <AssetImageSlot
              label={t("assets.scenes.reverse")}
              src={scene.reverse_master_url}
              emptyLabel={t("assets.scenes.noReverse")}
              fit="cover"
              onPreview={reverseResolved ? () => { setPreviewSrc(reverseResolved); setPreviewLabel(t("assets.scenes.reverse")); } : undefined}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onGenerateReverse}
                disabled={!hasMaster || reverseRunning}
                className="h-7 gap-1 rounded-[8px] px-2 text-xs active:scale-95 transition-transform"
              >
                {reverseRunning ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {hasReverse
                  ? t("assets.scenes.regenerateReverse")
                  : t("assets.scenes.generateReverse")}
                <CreditCostInline display={reverseCost} />
              </Button>
            </div>
          </div>

          {/* Panorama column */}
          <div className="flex flex-col gap-3">
            <AssetImageSlot
              label={t("assets.scenes.pano")}
              src={scene.pano_url}
              emptyLabel={t("assets.scenes.noPano")}
              fit="contain"
              onPreview={panoResolved ? () => { setPreviewSrc(panoResolved); setPreviewLabel(t("assets.scenes.pano")); } : undefined}
              actions={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); onDeletePano(); }}
                  disabled={!hasPano}
                  aria-label={t("assets.scenes.deletePano")}
                  className="size-6 rounded-[4px] bg-black/50 p-0 text-white/70 hover:bg-destructive/30 hover:text-destructive backdrop-blur-sm"
                >
                  <Trash2 className="size-3" />
                </Button>
              }
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onGeneratePano(panoSource)}
                disabled={panoRunning}
                className="h-7 gap-1 rounded-[8px] px-2 text-xs active:scale-95 transition-transform"
              >
                {panoRunning ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ImageIcon className="size-3" />
                )}
                {panoGenerateLabel}
                <CreditCostInline display={panoCost} />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onUploadPano}
                className="h-7 gap-1 rounded-[8px] px-2 text-xs active:scale-95 transition-transform"
              >
                <Upload className="size-3" />
                {t("assets.scenes.uploadPano")}
              </Button>
              {hasPano && onOpenPanoViewer && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onOpenPanoViewer}
                  className="h-7 gap-1 rounded-[8px] px-2 text-xs active:scale-95 transition-transform"
                >
                  <ExternalLink className="size-3" />
                  {t("assets.scenes.openPanoViewer")}
                </Button>
              )}
            </div>
          </div>

          {/* 3D world section — full width below the image columns */}
          {canOpenStageViewer && (
            <section className="rounded-[10px] bg-cyan-500/[0.055] p-3 md:col-span-2 xl:col-span-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Package className="size-4 text-cyan-400" />
                    {t("assets.scenes.stage.title")}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StagePlyBadge label={t("assets.scenes.stage.customWorld")} file={stage?.custom} />
                <StagePlyBadge label={t("assets.scenes.stage.masterWorld")} file={stage?.master} />
                <StagePlyBadge label={t("assets.scenes.stage.reverseWorld")} file={stage?.reverse} />
                <StagePlyBadge label={t("assets.scenes.stage.panoWorld")} file={stage?.pano} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onUploadCustomPackage}
                  disabled={customUploading}
                  className="h-8 gap-1.5 rounded-[8px] px-2.5 text-xs"
                >
                  {customUploading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Upload className="size-3.5" />
                  )}
                  {t("assets.scenes.stage.uploadCustom")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onDeleteCustomPackage}
                  disabled={!stage?.custom.ready || customDeleting}
                  className="h-8 gap-1.5 rounded-[8px] px-2.5 text-xs text-muted-foreground"
                >
                  {customDeleting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  {t("assets.scenes.stage.deleteCustom")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onGenerateStagePly("master")}
                  disabled={!hasMaster || stageBusy}
                  className="h-8 gap-1.5 rounded-[8px] px-2.5 text-xs"
                >
                  {masterPlyRunning ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {t("assets.scenes.stage.masterToPly")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onGenerateStagePly("reverse")}
                  disabled={!hasReverse || stageBusy}
                  className="h-8 gap-1.5 rounded-[8px] px-2.5 text-xs"
                >
                  {reversePlyRunning ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {t("assets.scenes.stage.reverseToPly")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onGenerateStagePly("pano")}
                  disabled={!hasPano || panoRunning || stageBusy}
                  className="h-8 gap-1.5 rounded-[8px] px-2.5 text-xs"
                >
                  {panoPlyRunning ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {t("assets.scenes.stage.panoToPly")}
                </Button>
                {canOpenStageViewer ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={onOpenStageViewer}
                    className="h-8 gap-1.5 rounded-[8px] px-2.5 text-xs"
                  >
                    <ExternalLink className="size-3.5" />
                    {t("assets.scenes.stage.openWorld")}
                  </Button>
                ) : (
                  <span className="rounded-[8px] px-2.5 py-1.5 text-xs text-muted-foreground">
                    {t("assets.scenes.stage.worldNotReady")}
                  </span>
                )}
              </div>
            </section>
          )}
        </CardContent>
      </Card>
      {previewSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setPreviewSrc(null)}
        >
          <a
            href={previewSrc}
            download
            aria-label="Download image"
            className="absolute right-14 top-4 rounded-full bg-background/80 p-2 text-foreground/80 transition duration-150 hover:scale-105 hover:bg-background hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <Download className="size-5" />
          </a>
          <button
            type="button"
            onClick={() => setPreviewSrc(null)}
            className="absolute right-4 top-4 rounded-full bg-background/80 p-2 text-foreground/80 transition duration-150 hover:scale-105 hover:bg-background hover:text-foreground"
          >
            <X className="size-5" />
          </button>
          <img
            src={previewSrc}
            alt={previewLabel}
            className="max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] rounded-[8px] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
