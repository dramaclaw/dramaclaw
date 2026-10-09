// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId, useRef, useState, type DragEvent } from "react";
import { ImageUp, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CreditCostInline } from "@/components/credit-cost-inline";
import { ProviderModelPicker } from "@/features/canvas/ui/ProviderModelPicker";
import type { PrevizBlockoutImportMode } from "@/features/previz/domain/blockout";
import {
  PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS,
  PREVIZ_BLOCKOUT_IMAGE_EXTENSIONS,
  blockoutImageHints,
  isAcceptedBlockoutImage,
  type PrevizBlockoutImageHint,
  type PrevizImageSize,
} from "@/features/previz/domain/blockoutImage";
import {
  PREVIZ_BLOCKOUT_GUIDE_KEYS,
  PREVIZ_BLOCKOUT_HINT_KEY,
  blockoutRejectionMessage,
} from "@/features/previz/ui/blockoutMessages";
import type { PrevizHeldBlockout } from "@/features/previz/blockoutLanding";
import { useBlockoutModels } from "@/features/previz/ui/useBlockoutModels";
import type {
  PrevizBlockoutRequest,
  PrevizBlockoutStage,
} from "@/features/previz/ui/useBlockoutGeneration";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { cn } from "@/lib/utils";

/** 与后端 `freezone_image_to_blockout_task_billing` 的 feature_key 一致。 */
export const PREVIZ_BLOCKOUT_FEATURE_KEY = "freezone.image_to_blockout";
const ACCEPT = PREVIZ_BLOCKOUT_IMAGE_EXTENSIONS.map((extension) => `.${extension}`).join(",");
const MODES: readonly PrevizBlockoutImportMode[] = ["replace", "append"];

export interface PrevizBlockoutDialogProps {
  open: boolean;
  stage: PrevizBlockoutStage;
  /** 上一次生成好、但没放进场景的结果。 */
  held: PrevizHeldBlockout | null;
  /** 场景里已经有白模：这次是替换它还是再加一份，得问。 */
  hasExisting: boolean;
  onStart: (request: PrevizBlockoutRequest) => void;
  onRetryImport: (mode: PrevizBlockoutImportMode) => void;
  onClose: () => void;
  /** 读图片的像素尺寸；读不出来给 null。测试里换掉它——jsdom 不解码图片。 */
  measureImage?: (file: File) => Promise<PrevizImageSize | null>;
}

/** 拖的是文件才算数：拖一段文字、一个链接时 `types` 里没有这一项。 */
function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/** 用一个不挂进文档的 `<img>` 读尺寸，做法同 `engine/audioProbe.ts`。 */
export function measureImageFile(file: File): Promise<PrevizImageSize | null> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    const settle = (size: PrevizImageSize | null) => {
      URL.revokeObjectURL(objectUrl);
      resolve(size);
    };
    image.onload = () => settle({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => settle(null);
    image.src = objectUrl;
  });
}

/**
 * 圆角一律走 token（这个项目里 `rounded-sm/md/lg/xl` = 12/14/16/20px，见 DESIGN.md）：
 * 胶囊给「可点但不是提交」的，柔和矩形给容器和提交按钮。
 */
const ICON_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white/90";
const SECONDARY_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--ui-border-strong)] bg-white/[0.04] px-3.5 text-[12px] font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/[0.04]";
const PRIMARY_BUTTON =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-white/90 px-4 text-[13px] font-semibold text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/35";
const MODE_BUTTON =
  "h-7 rounded-full px-3 text-[12px] text-white/55 transition-colors hover:text-white/90 aria-pressed:bg-white/[0.12] aria-pressed:text-white disabled:cursor-not-allowed disabled:opacity-40";
const FIELD =
  "w-full rounded-sm border border-transparent bg-[var(--ui-surface-field)] px-3 py-2 text-[13px] leading-relaxed text-white/90 outline-none transition-colors placeholder:text-white/30 focus:border-white/20 disabled:cursor-not-allowed disabled:opacity-50";
const LABEL = "text-[13px] font-medium text-white/80";
const HELPER = "text-[12px] leading-relaxed text-white/45";
/** 一组相关的设置收进一块浅底里，组与组之间靠间距分开，不画分割线。 */
const GROUP = "rounded-lg border border-[var(--ui-border-soft)] bg-white/[0.03]";
const CHECKBOX = "mt-[3px] h-3.5 w-3.5 shrink-0 accent-white/85 disabled:opacity-50";

/**
 * 「从参考图生成场景」：选一张图、可选地补一句说明，生成一套能逐件改的基础几何体。
 *
 * 铺在视口上而不是再套一层 base-ui Dialog，理由同模型库对话框：编辑器本身已经是个
 * 全屏 Dialog，嵌套会把焦点陷阱和 Esc 各劫持一遍。
 */
export function PrevizBlockoutDialog({ open, ...props }: PrevizBlockoutDialogProps) {
  // 关掉就整个卸载：选过的图、写过的说明不跨次保留。
  if (!open) return null;
  return <BlockoutPanel {...props} />;
}

function BlockoutPanel({
  stage,
  held,
  hasExisting,
  onStart,
  onRetryImport,
  onClose,
  measureImage = measureImageFile,
}: Omit<PrevizBlockoutDialogProps, "open">) {
  const { t } = useTranslation();
  const fileInputId = useId();
  const noteId = useId();
  const pictureCheckId = useId();
  const pictureCheckHintId = useId();
  const renderCheckId = useId();
  const renderCheckHintId = useId();
  const modelLabelId = useId();
  const guideId = useId();
  const hintId = useId();
  const heldId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [hints, setHints] = useState<PrevizBlockoutImageHint[]>([]);
  const [imageSize, setImageSize] = useState<PrevizImageSize | null>(null);
  const [description, setDescription] = useState("");
  const [pictureCheck, setPictureCheck] = useState(false);
  const [renderCheck, setRenderCheck] = useState(false);
  // 下拉里的选择。空串 = 还没动过 = 第一项（默认）；提交时默认不随请求发出，
  // 让服务端按当时的配置解析，免得页面开着的时候设置页改了默认。
  const [modelId, setModelId] = useState("");
  const models = useBlockoutModels();
  const defaultModel = models[0];
  const modelOptions = models.map((model, index) =>
    index === 0
      ? { ...model, label: t("previz.blockout.modelDefault", { name: model.label }) }
      : model,
  );
  const chosenModel = models.find((model) => model.id === modelId) ?? defaultModel;
  const requestedModel = chosenModel && chosenModel !== defaultModel ? chosenModel.id : "";
  const [mode, setMode] = useState<PrevizBlockoutImportMode>("replace");
  const [dragging, setDragging] = useState(false);
  /** 量尺寸是异步的：连着选两张图时，先选那张的结果不能盖到后选那张头上。 */
  const measureSerial = useRef(0);
  /**
   * 文件在对话框的子元素之间移动时，浏览器先发 enter 再发 leave；
   * 数层数而不是看最后一个事件，高亮才不会一路闪。做法同画布的文件拖放。
   */
  const dragDepth = useRef(0);

  const cost = useGenerationCreditCost("feature", PREVIZ_BLOCKOUT_FEATURE_KEY, {
    surface: "canvas",
    quantity: 1,
    params: { operation: "image_to_blockout" },
  });
  const billingRuleMissing = cost.error instanceof BillingRuleNotConfiguredError;
  const costDisplay =
    cost.data?.data.display ??
    (billingRuleMissing ? t("common.billingRuleNotConfiguredShort") : null);

  const busy = stage !== "idle";
  const canStart = file !== null && !busy && !billingRuleMissing;

  const handlePick = (picked: File) => {
    measureSerial.current += 1;
    const mine = measureSerial.current;
    setHints([]);
    setImageSize(null);
    const verdict = isAcceptedBlockoutImage(picked.name, picked.size);
    if (verdict !== "ok") {
      // 格式和体积是硬门槛——后端不收，传上去也是白传。
      setFile(null);
      setRefusal(
        t(verdict === "extension" ? "previz.blockout.badExtension" : "previz.blockout.tooLarge"),
      );
      return;
    }
    setFile(picked);
    setRefusal(null);
    // 尺寸、比例只提示不拦：量不出来就不提示，照样能生成。
    void measureImage(picked)
      .catch(() => null)
      .then((size) => {
        if (measureSerial.current !== mine) return;
        setHints(blockoutImageHints(size));
        setImageSize(size);
      });
  };

  // 编辑器挂在画布节点底下，合成事件顺着组件树冒泡：四个事件都要截住，
  // 不然画布会亮起它自己的蒙层，还会把这张图当成新节点收走。
  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (busy) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!carriesFiles(event)) return;
    // 不 preventDefault 的话浏览器不认这里能放，松手就直接打开那张图、把整页换掉。
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? "none" : "copy";
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!carriesFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    // 一次只用一张：拖进来好几张就取第一张，取了哪张看文件名。
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) handlePick(dropped);
  };

  return (
    <section
      role="dialog"
      aria-modal="true"
      // tabIndex 的理由见 PrevizModelLibraryDialog：空白处的点击要就地接住焦点，
      // 否则编辑器的 Delete/空格快捷键会穿透过来。
      tabIndex={-1}
      aria-label={t("previz.blockout.title")}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6"
      // 整个对话框都接：放偏了一点也算数，不至于掉到浏览器手里。
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex max-h-full w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-[var(--ui-border-strong)] bg-[var(--ui-surface-modal)] shadow-[var(--ui-shadow-panel)]">
        <header className="flex shrink-0 items-center justify-between gap-3 px-6 pt-5 pb-4">
          <h4 className="text-[15px] font-semibold text-white/95">{t("previz.blockout.title")}</h4>
          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={t("previz.blockout.close")}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* 两栏：左边是图（选图 + 什么图好），右边是怎么生成（说明 + 设置）。窄了就叠回一栏。 */}
        <div className="ui-scrollbar grid min-h-0 flex-1 grid-cols-1 content-start gap-x-5 gap-y-5 overflow-y-auto px-6 pb-2 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <div
              data-testid="previz-blockout-drop-zone"
              data-dragging={dragging}
              className={cn(
                "flex min-h-[220px] flex-1 flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center transition-colors",
                dragging && "border-white/60 bg-white/[0.07]",
              )}
            >
              <span
                aria-hidden="true"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06] text-white/60"
              >
                <ImageUp className="h-5 w-5" />
              </span>
              {file && (
                <span className="max-w-full truncate text-[13px] font-medium text-white/90">
                  {file.name}
                </span>
              )}
              {/* sr-only + label 的理由见 PrevizModelLibraryDialog 的导入按钮。 */}
              <input
                id={fileInputId}
                type="file"
                accept={ACCEPT}
                disabled={busy}
                className="peer sr-only"
                onChange={(event) => {
                  const picked = event.target.files?.[0];
                  if (picked) handlePick(picked);
                  // 清空 value：不清的话选同一个文件第二次不会触发 change。
                  event.target.value = "";
                }}
              />
              <label
                htmlFor={fileInputId}
                className={cn(
                  SECONDARY_BUTTON,
                  "cursor-pointer peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                  busy && "cursor-not-allowed opacity-40 hover:bg-white/[0.04]",
                )}
              >
                {t("previz.blockout.pick")}
              </label>
              <span className={cn("text-[12px]", dragging ? "text-white/90" : "text-white/40")}>
                {t(dragging ? "previz.blockout.dropNow" : "previz.blockout.dropHint")}
              </span>
            </div>

            {refusal && (
              <p role="alert" className="text-[12px] text-red-300">
                {refusal}
              </p>
            )}

            {hints.length > 0 && (
              <div className="flex flex-col gap-1 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3.5 py-3 text-[12px] leading-relaxed text-amber-100/80">
                <p id={hintId} className="font-medium text-amber-100/95">
                  {t("previz.blockout.hint.title")}
                </p>
                <ul aria-labelledby={hintId} className="list-disc pl-4">
                  {hints.map((hint) => (
                    <li key={hint}>{t(PREVIZ_BLOCKOUT_HINT_KEY[hint])}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className={cn(GROUP, "flex flex-col gap-1.5 px-3.5 py-3")}>
              <p id={guideId} className="text-[12px] font-medium text-white/70">
                {t("previz.blockout.guide.title")}
              </p>
              <ul
                aria-labelledby={guideId}
                className={cn(HELPER, "list-disc pl-4 marker:text-white/25")}
              >
                {PREVIZ_BLOCKOUT_GUIDE_KEYS.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>

          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <label htmlFor={noteId} className={LABEL}>
                  {t("previz.blockout.description")}
                </label>
                <span className="text-[12px] tabular-nums text-white/35">
                  {`${description.length} / ${PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS}`}
                </span>
              </div>
              <textarea
                id={noteId}
                rows={5}
                maxLength={PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS}
                disabled={busy}
                placeholder={t("previz.blockout.descriptionPlaceholder")}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className={cn(FIELD, "resize-none")}
              />
            </div>

            <div className={cn(GROUP, "flex flex-col gap-3.5 px-3.5 py-3.5")}>
              {models.length > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <span id={modelLabelId} className={LABEL}>
                    {t("previz.blockout.model")}
                  </span>
                  <ProviderModelPicker
                    selectedModelId={chosenModel?.id ?? ""}
                    onChange={setModelId}
                    models={modelOptions}
                    popoverPlacement="bottom"
                  />
                </div>
              )}

              <div className="flex items-start gap-2.5">
                <input
                  id={pictureCheckId}
                  type="checkbox"
                  disabled={busy}
                  checked={pictureCheck}
                  aria-describedby={pictureCheckHintId}
                  onChange={(event) => setPictureCheck(event.target.checked)}
                  className={CHECKBOX}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <label htmlFor={pictureCheckId} className={LABEL}>
                    {t("previz.blockout.pictureCheck")}
                  </label>
                  <span id={pictureCheckHintId} className={HELPER}>
                    {t("previz.blockout.pictureCheckHint")}
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-2.5">
                <input
                  id={renderCheckId}
                  type="checkbox"
                  disabled={busy}
                  checked={renderCheck}
                  aria-describedby={renderCheckHintId}
                  onChange={(event) => setRenderCheck(event.target.checked)}
                  className={CHECKBOX}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <label htmlFor={renderCheckId} className={LABEL}>
                    {t("previz.blockout.renderCheck")}
                  </label>
                  <span id={renderCheckHintId} className={HELPER}>
                    {t("previz.blockout.renderCheckHint")}
                  </span>
                </div>
              </div>

              {hasExisting && (
                <div
                  role="group"
                  aria-label={t("previz.blockout.mode.title")}
                  className="flex items-center justify-between gap-2"
                >
                  <span className={LABEL}>{t("previz.blockout.mode.title")}</span>
                  <div className="flex items-center gap-0.5 rounded-full bg-white/[0.05] p-0.5">
                    {MODES.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={mode === value}
                        disabled={busy}
                        className={MODE_BUTTON}
                        onClick={() => setMode(value)}
                      >
                        {t(`previz.blockout.mode.${value}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

          </div>

          {held && (
            <section
              aria-labelledby={heldId}
              className={cn(
                GROUP,
                "md:col-span-2 flex flex-col gap-2 px-3.5 py-3 text-[12px] leading-relaxed text-white/70",
              )}
            >
              <p id={heldId} className="text-[13px] font-medium text-white/90">
                {t("previz.blockout.held.title")}
              </p>
              <p>{blockoutRejectionMessage(held.rejection, t)}</p>
              <p className="text-white/45">{t("previz.blockout.held.free")}</p>
              <button
                type="button"
                disabled={busy}
                className={cn(SECONDARY_BUTTON, "self-start")}
                onClick={() => onRetryImport(mode)}
              >
                {t("previz.blockout.held.retry")}
              </button>
            </section>
          )}

          {busy && (
            <div className={cn(GROUP, "flex flex-col gap-1 px-3.5 py-3 md:col-span-2")}>
              <p role="status" className="flex items-center gap-2 text-[13px] text-white/85">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t(`previz.blockout.stage.${stage}`)}
              </p>
              <p className={HELPER}>{t("previz.blockout.closeDiscards")}</p>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-3 px-6 pt-4 pb-5 text-white/70">
          <CreditCostInline display={costDisplay} promotion={cost.data?.data.promotion} />
          <button
            type="button"
            disabled={!canStart}
            className={PRIMARY_BUTTON}
            onClick={() => {
              if (file) {
                onStart({
                  file,
                  imageSize,
                  description,
                  pictureCheck,
                  renderCheck,
                  model: requestedModel,
                  mode,
                });
              }
            }}
          >
            {t("previz.blockout.submit")}
          </button>
        </footer>
      </div>
    </section>
  );
}
