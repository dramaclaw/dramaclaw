// SPDX-License-Identifier: Elastic-2.0
import { useFreezoneVideoModels } from "../hooks/useFreezoneVideoModels";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { UiChipButton } from "@/components/ui";
import {
  TOOLBAR_TEXT_BUTTON_CLASS,
  TOOLBAR_MENU_CONTENT_CLASS,
} from "./nodeToolbarStyles";
import { useState } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Film, Shapes } from "lucide-react";
import {
  type CanvasNode,
  resolveNodeSourceImageUrl,
} from "../domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import { readUrl } from "@/lib/url-params";
import {
  generateDerivedMedia,
  type DerivedMediaKind,
} from "../application/derivedMedia";
export function useDerivedVideoCost() {
  const catalog = useFreezoneVideoModels();
  const model = catalog.models.find((m) => m.id === "newapi_seedance-2.0-fast");
  const cost = useGenerationCreditCost(
    "feature",
    model ? "freezone.video_generate" : null,
    {
      surface: "canvas",
      quantity: 1,
      params: {
        catalog_id: model?.catalogId,
        video_backend: model?.apiModel,
        pricing_quantity: 4,
        operation: "firstLastFrame",
        resolution: "720p",
        generate_audio: false,
        video_input_present: false,
        input_video_duration_seconds: 0,
      },
    },
  );
  return { cost, available: Boolean(model) };
}

export function ImageDerivedActions({ node }: { node: CanvasNode }) {
  const { cost, available } = useDerivedVideoCost();
  const [kind, setKind] = useState<DerivedMediaKind | null>(null);
  const store = useCanvasStore();
  if (
    !["uploadNode", "imageNode", "imageGenNode", "exportImageNode"].includes(
      node.type || "",
    )
  )
    return null;
  const imageUrl = resolveNodeSourceImageUrl(node);
  if (!imageUrl) return null;
  const submit = () => {
    const { project, canvas } = readUrl();
    if (
      !project ||
      !kind ||
      (kind === "gif" && (!available || cost.isLoading || Boolean(cost.error)))
    )
      return;
    const id = store.addNode(
      kind === "svg" ? "vectorSvgNode" : "animatedGifNode",
      store.findNodePosition(node.id, 360, 300),
      {
        sourceImageUrl: imageUrl,
        aspectRatio: node.data.aspectRatio || "16:9",
      },
    );
    store.addEdge(node.id, id);
    store.setSelectedNode(id);
    setKind(null);
    void generateDerivedMedia(
      project,
      id,
      kind,
      imageUrl,
      undefined,
      canvas,
      (patch) => store.updateNodeData(id, patch),
    );
  };
  return (
    <>
      {(["svg", "gif"] as const).map((operation) => (
        <Popover
          key={operation}
          open={kind === operation}
          onOpenChange={(open) => setKind(open ? operation : null)}
        >
          <PopoverTrigger
            render={<UiChipButton className={TOOLBAR_TEXT_BUTTON_CLASS} />}
            onClick={(event) => event.stopPropagation()}
          >
            {operation === "svg" ? <Shapes size={14} /> : <Film size={14} />}
            {operation === "svg" ? "矢量图" : "动态图"}
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className={`nodrag w-72 space-y-3 ${TOOLBAR_MENU_CONTENT_CLASS}`}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-sm font-medium">
              {operation === "svg" ? "生成 SVG 矢量图" : "生成 GIF 动态图"}
            </p>
            <p className="text-xs text-muted-foreground">
              {operation === "svg"
                ? "本地转换 SVG，复杂图片可能损失细节。"
                : "首帧锁定 · 4 秒 · 720P · 无音频"}
            </p>
            {operation === "gif" && Boolean(cost.error) && (
              <p role="alert" className="text-xs text-destructive">
                {cost.error instanceof BillingRuleNotConfiguredError
                  ? "计费规则未配置，请联系管理员。"
                  : "暂时无法获取积分报价，请稍后重试。"}
              </p>
            )}
            {operation === "gif" && !available && (
              <p className="text-xs text-text-muted">视频模型暂不可用</p>
            )}
            {operation === "gif" && cost.isLoading && (
              <p className="text-xs text-text-muted">正在获取积分报价…</p>
            )}
            <div className="flex items-center justify-between">
              <CreditCostInline
                display={operation === "svg" ? "免费" : cost.data?.data.display}
              />
              <UiChipButton
                disabled={
                  operation === "gif" &&
                  (!available || cost.isLoading || Boolean(cost.error))
                }
                onClick={submit}
                className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40"
              >
                生成
              </UiChipButton>
            </div>
          </PopoverContent>
        </Popover>
      ))}
    </>
  );
}
