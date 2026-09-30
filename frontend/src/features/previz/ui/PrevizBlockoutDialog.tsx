// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId, useRef, useState, type DragEvent } from "react";
import { ImageUp, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CreditCostInline } from "@/components/credit-cost-inline";
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

/** 与模型库对话框同一套（见 PrevizModelLibraryDialog）。 */
const STEP_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/45 transition-colors hover:bg-white/10 hover:text-white/90";
const SECONDARY_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/10 px-3 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";
const PRIMARY_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white/90 px-3 text-[12px] font-medium text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-white/40";
const MODE_BUTTON =
  "h-7 rounded-md px-2.5 text-[12px] text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/90 aria-pressed:bg-white/10 aria-pressed:text-white/90 disabled:cursor-not-allowed disabled:opacity-40";
const FIELD =
  "w-full rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/90 outline-none placeholder:text-white/30 focus:border-white/25 disabled:cursor-not-allowed disabled:opacity-50";

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
  const guideId = useId();
  const hintId = useId();
  const heldId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [hints, setHints] = useState<PrevizBlockoutImageHint[]>([]);
  const [description, setDescription] = useState("");
  const [pictureCheck, setPictureCheck] = useState(false);
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
        if (measureSerial.current === mine) setHints(blockoutImageHints(size));
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
      <div className="flex max-h-full w-full max-w-[520px] flex-col gap-3 overflow-y-auto rounded-xl border border-white/10 bg-[#14161b] p-4 shadow-2xl">
        <header className="flex items-center justify-between">
          <h4 className="text-[13px] font-medium text-white/90">{t("previz.blockout.title")}</h4>
          <button
            type="button"
            className={STEP_BUTTON}
            aria-label={t("previz.blockout.close")}
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex flex-col gap-1 text-[12px] text-white/50">
          <p id={guideId}>{t("previz.blockout.guide.title")}</p>
          <ul aria-labelledby={guideId} className="list-disc pl-4">
            {PREVIZ_BLOCKOUT_GUIDE_KEYS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </div>

        <div
          data-testid="previz-blockout-drop-zone"
          data-dragging={dragging}
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-md border border-dashed border-white/15 p-3 transition-colors",
            dragging && "border-white/60 bg-white/[0.06]",
          )}
        >
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
              busy && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            <ImageUp className="h-3.5 w-3.5" />
            {t("previz.blockout.pick")}
          </label>
          {file && <span className="min-w-0 truncate text-[12px] text-white/70">{file.name}</span>}
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
          <div className="flex flex-col gap-1 rounded-md border border-amber-300/20 bg-amber-300/[0.06] p-2 text-[12px] text-amber-100/80">
            <p id={hintId}>{t("previz.blockout.hint.title")}</p>
            <ul aria-labelledby={hintId} className="list-disc pl-4">
              {hints.map((hint) => (
                <li key={hint}>{t(PREVIZ_BLOCKOUT_HINT_KEY[hint])}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor={noteId} className="text-[12px] text-white/60">
            {t("previz.blockout.description")}
          </label>
          <textarea
            id={noteId}
            rows={3}
            maxLength={PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS}
            disabled={busy}
            placeholder={t("previz.blockout.descriptionPlaceholder")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={cn(FIELD, "resize-none")}
          />
          <span className="self-end text-[11px] tabular-nums text-white/35">
            {`${description.length} / ${PREVIZ_BLOCKOUT_DESCRIPTION_MAX_CHARS}`}
          </span>
        </div>

        <div className="flex items-start gap-2">
          <input
            id={pictureCheckId}
            type="checkbox"
            disabled={busy}
            checked={pictureCheck}
            aria-describedby={pictureCheckHintId}
            onChange={(event) => setPictureCheck(event.target.checked)}
            className="mt-0.5 accent-white/80"
          />
          <div className="flex flex-col gap-0.5">
            <label htmlFor={pictureCheckId} className="text-[12px] text-white/60">
              {t("previz.blockout.pictureCheck")}
            </label>
            <span id={pictureCheckHintId} className="text-[11px] text-white/35">
              {t("previz.blockout.pictureCheckHint")}
            </span>
          </div>
        </div>

        {hasExisting && (
          <div
            role="group"
            aria-label={t("previz.blockout.mode.title")}
            className="flex items-center gap-1"
          >
            <span className="mr-1 text-[12px] text-white/60">
              {t("previz.blockout.mode.title")}
            </span>
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
        )}

        {held && (
          <section
            aria-labelledby={heldId}
            className="flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.04] p-2 text-[12px] text-white/70"
          >
            <p id={heldId} className="text-white/90">
              {t("previz.blockout.held.title")}
            </p>
            <p>{blockoutRejectionMessage(held.rejection, t)}</p>
            <p className="text-white/50">{t("previz.blockout.held.free")}</p>
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
          <div className="flex flex-col gap-1 text-[12px]">
            <p role="status" className="flex items-center gap-1.5 text-white/80">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t(`previz.blockout.stage.${stage}`)}
            </p>
            <p className="text-white/45">{t("previz.blockout.closeDiscards")}</p>
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-white/10 pt-3 text-white/70">
          <CreditCostInline display={costDisplay} promotion={cost.data?.data.promotion} />
          <button
            type="button"
            disabled={!canStart}
            className={PRIMARY_BUTTON}
            onClick={() => {
              if (file) onStart({ file, description, pictureCheck, mode });
            }}
          >
            {t("previz.blockout.submit")}
          </button>
        </footer>
      </div>
    </section>
  );
}
