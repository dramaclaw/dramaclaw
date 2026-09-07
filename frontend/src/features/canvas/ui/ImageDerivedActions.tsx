// SPDX-License-Identifier: Elastic-2.0
import { useFreezoneVideoModels } from "../hooks/useFreezoneVideoModels";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { UiChipButton } from "@/components/ui";
import { TOOLBAR_TEXT_BUTTON_CLASS } from "./nodeToolbarStyles";
import { NodeToolbar, Position } from "@xyflow/react";
import { ZoomScaledToolbar } from "./ZoomScaledToolbar";
import { NODE_TOOLBAR_CLASS } from "./nodeToolbarConfig";
import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from "./nodeFrameStyles";
import {
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from "./nodeControlStyles";
import { ArrowUp, X, Film, Shapes } from "lucide-react";
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

export function ImageDerivedActions({
  node,
  onOpen,
}: {
  node: CanvasNode;
  onOpen: (id: string, kind: DerivedMediaKind) => void;
}) {
  if (!resolveNodeSourceImageUrl(node)) return null;
  return (
    <>
      {(["svg", "gif"] as const).map((kind) => (
        <UiChipButton
          key={kind}
          className={TOOLBAR_TEXT_BUTTON_CLASS}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(node.id, kind);
          }}
        >
          {kind === "svg" ? <Shapes size={14} /> : <Film size={14} />}
          {kind === "svg" ? "矢量图" : "动态图"}
        </UiChipButton>
      ))}
    </>
  );
}
export function ImageDerivedOverlay({
  node,
  kind,
  onClose,
}: {
  node: CanvasNode;
  kind: DerivedMediaKind;
  onClose: () => void;
}) {
  const { cost, available } = useDerivedVideoCost();
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
    onClose();
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
  const disabled =
    kind === "gif" && (!available || cost.isLoading || Boolean(cost.error));
  const message =
    kind === "svg"
      ? "本地转换 SVG，复杂图片可能损失细节。"
      : !available
        ? "视频模型暂不可用"
        : cost.error
          ? cost.error instanceof BillingRuleNotConfiguredError
            ? "计费规则未配置，请联系管理员。"
            : "暂时无法获取积分报价，请稍后重试。"
          : cost.isLoading
            ? "正在获取积分报价…"
            : "首帧锁定 · 4 秒 · 720P · 无音频";
  return (
    <NodeToolbar
      nodeId={node.id}
      isVisible
      position={Position.Bottom}
      align="center"
      offset={12}
      className={NODE_TOOLBAR_CLASS}
    >
      <ZoomScaledToolbar origin="top center">
        <div
          className={`flex min-w-[420px] items-center gap-2 ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
          <div
            title={message}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-text-dark"
          >
            {kind === "svg" ? (
              <Shapes className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : (
              <Film className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            )}
            <span className="truncate font-medium">
              {kind === "svg" ? "矢量图" : "动态图"}
            </span>
            {disabled && (
              <span
                role={cost.error ? "alert" : "status"}
                className="text-text-muted"
              >
                {message}
              </span>
            )}
          </div>
          <CreditCostInline
            display={kind === "svg" ? "免费" : cost.data?.data.display}
            promotion={kind === "gif" ? cost.data?.data.promotion : undefined}
          />
          <button
            type="button"
            aria-label="生成"
            title={disabled ? message : "生成"}
            disabled={disabled}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} shrink-0 ${disabled ? NODE_GENERATE_BUTTON_DISABLED_CLASS : NODE_GENERATE_BUTTON_ENABLED_CLASS}`}
            onClick={submit}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </ZoomScaledToolbar>
    </NodeToolbar>
  );
}
