import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CreditSparkIcon } from "@/components/credits/credit-visual";
import type { MidjourneyUpscaleCandidate } from "../domain/midjourneyImageOperations";

interface Props {
  candidates: MidjourneyUpscaleCandidate[];
  results: Record<string, string>;
  onAction: (customId: string) => Promise<void>;
  costLabel?: string | null;
  billingUnavailable?: boolean;
}

/** Selecting pixels must never submit a billable Midjourney action. */
export function MidjourneyUpscalePicker({
  candidates,
  results,
  onAction,
  costLabel,
  billingUnavailable,
}: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [touchId, setTouchId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);

  return (
    <div
      className="nodrag absolute inset-0 z-20"
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
        {candidates.map((item) => {
          const cached = Boolean(results[item.customId]);
          const hint = cached
            ? t("node.imageGen.upscaleCached")
            : billingUnavailable
              ? t("common.billingRuleNotConfiguredShort")
              : costLabel
                ? t("node.imageGen.upscaleCost", {
                    cost: costLabel,
                  })
                : t("node.imageGen.upscaleConfirmHint");
          return (
            <div
              key={item.customId}
              role="group"
              aria-label={item.label}
              className="group/candidate relative min-h-0 min-w-0"
              data-touch-active={touchId === item.customId}
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  setTouchId((current) =>
                    current === item.customId ? null : current,
                  );
                }
              }}
              style={{
                gridColumn: ((item.index - 1) % 2) + 1,
                gridRow: Math.ceil(item.index / 2),
              }}
            >
              <button
                type="button"
                aria-label={t("node.imageGen.selectUpscaleCandidate", {
                  label: item.label,
                })}
                aria-pressed={selectedId === item.customId}
                disabled={busy}
                className="absolute inset-0 flex items-start justify-start border border-white/10 p-2 text-xs text-white aria-pressed:ring-2 aria-pressed:ring-inset aria-pressed:ring-accent disabled:cursor-wait"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (event.pointerType === "touch") setTouchId(item.customId);
                  else setTouchId(null);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedId(item.customId);
                }}
              >
                <span className="rounded-full bg-black/75 px-2 py-1">
                  {item.label}
                  {results[item.customId] ? " ✓" : ""}
                </span>
              </button>
              <div className="pointer-events-none absolute bottom-2 right-2 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-md bg-surface-dark px-2 py-1 opacity-0 transition-opacity duration-150 group-hover/candidate:pointer-events-auto group-hover/candidate:opacity-100 group-has-[:focus-visible]/candidate:pointer-events-auto group-has-[:focus-visible]/candidate:opacity-100 group-data-[touch-active=true]/candidate:pointer-events-auto group-data-[touch-active=true]/candidate:opacity-100">
                <button
                  type="button"
                  className="tap-button tap-button-quiet-primary bg-surface-dark shrink-0 disabled:opacity-40"
                  title={hint}
                  aria-label={
                    cached
                      ? t("node.imageGen.viewUpscale", { label: item.label })
                      : `${t("node.imageGen.confirmUpscale")} ${item.label}`
                  }
                  disabled={busy || (!cached && billingUnavailable)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={async (event) => {
                    event.stopPropagation();
                    // Ignore the second click of a double-click and lock before awaiting.
                    if (event.detail > 1 || actionPending.current) return;
                    actionPending.current = true;
                    setBusy(true);
                    try {
                      await onAction(item.customId);
                    } finally {
                      actionPending.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  {cached
                    ? t("node.imageGen.viewUpscale", {
                        label: item.label,
                      })
                    : t("node.imageGen.confirmUpscale")}
                </button>
                {!cached && costLabel && !billingUnavailable && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-xs text-text"
                    aria-label={hint}
                    title={hint}
                  >
                    <CreditSparkIcon className="h-3.5 w-3.5" />
                    {costLabel}
                  </span>
                )}
                {!cached && billingUnavailable && (
                  <span className="text-xs text-text-muted">{hint}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
