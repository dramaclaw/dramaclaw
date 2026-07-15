// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef } from "react";
import {
  Edit3,
  ExternalLink,
  ImageIcon,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { LightboxImage } from "@/components/lightbox-image";
import { ASSET_CARD_META_BADGE_CLASS } from "@/components/assets/asset-card-styles";
import { UsageCountBadge } from "@/components/assets/usage-count-badge";
import { CopyAssetLinkButton } from "@/components/assets/copy-asset-link-button";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { resolveMediaUrl } from "@/lib/media-url";
import type { PropAsset } from "@/types/prop";

interface PropAssetCardProps {
  prop: PropAsset;
  generating?: boolean;
  uploading?: boolean;
  referenceCount?: number;
  referenceCost?: string;
  onEdit: () => void;
  onDelete: () => void;
  onGenerateReference: () => void;
  onUploadReference: (file: File) => void;
  onOpenFreezone: () => void;
  freezonePending?: boolean;
}

export function PropAssetCard({
  prop,
  generating = false,
  uploading = false,
  referenceCount = 0,
  referenceCost,
  onEdit,
  onDelete,
  onGenerateReference,
  onUploadReference,
  onOpenFreezone,
  freezonePending = false,
}: PropAssetCardProps) {
  const { t } = useTranslation();
  const uploadInputRef = useRef<HTMLInputElement>(null);

  function handleUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onUploadReference(file);
    event.target.value = "";
  }
  const referenceUrl = resolveMediaUrl(prop.reference_url);
  const referenceAlt = `${prop.name} ${t("assets.props.reference")}`;
  const description =
    prop.description?.trim() || prop.visual_prompt?.trim() || t("assets.props.noDescription");
  const propTypeLabel = prop.prop_type
    ? t(`assets.props.types.${prop.prop_type}`, { defaultValue: prop.prop_type })
    : "";

  return (
    <Card size="sm" className="rounded-[10px] bg-white/[0.03] shadow-none">
      {/* Header: title + status chips inline, action icons on right */}
      <CardHeader className="gap-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <CardTitle className="truncate">{prop.name}</CardTitle>
            <div className="flex shrink-0 flex-wrap items-center gap-1">
              {propTypeLabel && (
                <span className={ASSET_CARD_META_BADGE_CLASS}>
                  {propTypeLabel}
                </span>
              )}
              <span className={ASSET_CARD_META_BADGE_CLASS}>
                {t("assets.props.reference")}{" "}
                {referenceUrl ? t("assets.common.generated") : t("assets.common.missing")}
              </span>
              <UsageCountBadge count={referenceCount} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <CopyAssetLinkButton type="prop" id={prop.name} />
            <button
              type="button"
              onClick={onOpenFreezone}
              disabled={freezonePending}
              aria-label={t("assets.props.openFreezone")}
              title={t("assets.props.openFreezoneTip")}
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
        {prop.owner && (
          <p className="text-xs text-muted-foreground">
            {t("assets.props.owner")}：{prop.owner}
          </p>
        )}
        {description && (
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-1">
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleUploadChange}
        />
        {referenceUrl ? (
          <LightboxImage
            src={referenceUrl}
            alt={referenceAlt}
            fit="contain"
            blurBackdrop={false}
            className="aspect-[16/9] w-full rounded-[8px]"
          />
        ) : (
          <div className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 rounded-[8px] border border-dashed border-border bg-muted/20 text-muted-foreground">
            <Package className="size-6" />
            <span className="text-xs">{t("assets.props.noReference")}</span>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-start gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onGenerateReference}
            disabled={generating || uploading}
            className="h-7 gap-1 rounded-[8px] px-3 text-xs transition-transform active:scale-95"
          >
            {generating ? (
              <Loader2 className="size-3 animate-spin" />
            ) : referenceUrl ? (
              <RefreshCw className="size-3" />
            ) : (
              <ImageIcon className="size-3" />
            )}
            {generating
              ? t("assets.props.generatingReference")
              : referenceUrl
                ? t("assets.props.regenerateReference")
                : t("assets.props.generateReference")}
            <CreditCostInline display={referenceCost} />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => uploadInputRef.current?.click()}
            disabled={generating || uploading}
            className="h-7 gap-1 rounded-[8px] px-3 text-xs transition-transform active:scale-95"
          >
            {uploading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Upload className="size-3" />
            )}
            {uploading
              ? t("assets.props.uploadingReference")
              : t("assets.props.uploadReference")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
