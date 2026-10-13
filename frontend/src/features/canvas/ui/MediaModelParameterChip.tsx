import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MediaModelParameterDefinition } from "@/api/ops";
import { GEN_MODE_TO_CATALOG_MODE } from "@/features/canvas/nodes/shared/videoModelCapabilities";
import { NODE_TEXT_CONTROL_TRIGGER_CLASS } from "@/features/canvas/ui/nodeControlStyles";

interface Props {
  parameters?: MediaModelParameterDefinition[];
  values?: Record<string, unknown>;
  mode?: string;
  onChange: (values: Record<string, unknown>) => void;
  onOpenChange?: (open: boolean) => void;
}

const SERVER_MANAGED_PARAMETER_KEYS = new Set(["thinking_level"]);

export function userSelectableMediaModelParameters(
  parameters: MediaModelParameterDefinition[] | undefined,
  mode?: string,
): MediaModelParameterDefinition[] {
  const normalizedMode = mode ? (MODE_ALIASES[mode] ?? mode) : "";
  return (parameters ?? []).filter((item) => {
    if (SERVER_MANAGED_PARAMETER_KEYS.has(item.key)) return false;
    if (!item.modes?.length) return true;
    return Boolean(
      mode &&
      (item.modes.includes(mode) || item.modes.includes(normalizedMode)),
    );
  });
}

export function MediaModelParameterChip({
  parameters,
  values = {},
  mode,
  onChange,
  onOpenChange,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [openSelectKey, setOpenSelectKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () => userSelectableMediaModelParameters(parameters, mode),
    [mode, parameters],
  );

  const updateOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setOpenSelectKey(null);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) updateOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [open, updateOpen]);

  if (!visible.length) return null;
  const setValue = (key: string, value: unknown) =>
    onChange({ ...values, [key]: value });

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={t("canvas.modelParams.title")}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
        onClick={(event) => {
          event.stopPropagation();
          updateOpen(!open);
        }}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span>{t("canvas.modelParams.title")}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t("canvas.modelParams.title")}
          className="nodrag nowheel absolute bottom-full left-0 z-[70] mb-2 max-h-[min(70vh,32rem)] w-72 space-y-3 overflow-y-auto rounded-lg border border-white/10 bg-surface-dark p-3 shadow-[0_18px_48px_rgba(0,0,0,0.55)]"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {visible.map((item) => {
            const value =
              values[item.key] ??
              item.default ??
              (item.control === "switch" ? false : "");
            return (
              <div key={item.key} className="block space-y-1.5">
                <span className="block text-xs text-text-muted">
                  {item.label || item.key}
                </span>
                {item.control === "switch" ? (
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    onChange={(event) =>
                      setValue(item.key, event.target.checked)
                    }
                  />
                ) : item.control === "select" ? (
                  <ThemedSelect
                    item={item}
                    value={value}
                    open={openSelectKey === item.key}
                    defaultLabel={t("canvas.modelParams.defaultOption")}
                    onOpenChange={(next) =>
                      setOpenSelectKey(next ? item.key : null)
                    }
                    onChange={(next) => setValue(item.key, next)}
                  />
                ) : item.control === "multiselect" ? (
                  <ThemedMultiSelect
                    item={item}
                    value={Array.isArray(value) ? value : []}
                    onChange={(next) => setValue(item.key, next)}
                  />
                ) : (
                  <input
                    type={item.control === "number" ? "number" : "text"}
                    className="h-8 w-full rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
                    value={String(value)}
                    min={item.min}
                    max={item.max}
                    step={item.step}
                    onChange={(e) =>
                      setValue(
                        item.key,
                        item.control === "number"
                          ? e.target.value === ""
                            ? undefined
                            : Number(e.target.value)
                          : e.target.value,
                      )
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ThemedSelectProps {
  item: MediaModelParameterDefinition;
  value: unknown;
  open: boolean;
  defaultLabel: string;
  onOpenChange: (open: boolean) => void;
  onChange: (value: unknown) => void;
}

function ThemedSelect({
  item,
  value,
  open,
  defaultLabel,
  onOpenChange,
  onChange,
}: ThemedSelectProps) {
  const { t } = useTranslation();
  const label = item.label || item.key;
  const options = item.required
    ? (item.options ?? [])
    : ["", ...(item.options ?? [])];
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-h-8 w-full items-center justify-between rounded border border-border-dark bg-bg-dark px-2 text-left text-xs text-text-dark transition-colors hover:border-white/20"
        onClick={() => onOpenChange(!open)}
      >
        <span className="truncate">
          {parameterOptionLabel(item, value, defaultLabel, t)}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-[80] mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-white/10 bg-[var(--ui-surface-panel)] p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
        >
          {options.map((option) => {
            const token = optionToken(option);
            const selected = optionToken(value) === token;
            return (
              <button
                key={token || "default"}
                type="button"
                role="option"
                aria-selected={selected}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-text-dark hover:bg-white/[0.08]"
                onClick={() => {
                  onChange(optionValue(item, token));
                  onOpenChange(false);
                }}
              >
                <span>
                  {parameterOptionLabel(item, option, defaultLabel, t)}
                </span>
                {selected && <Check className="h-3.5 w-3.5 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function parameterOptionLabel(
  item: MediaModelParameterDefinition,
  option: unknown,
  defaultLabel: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (option === "") return defaultLabel;
  const token = typeof option === "string" ? option : optionToken(option);
  if (item.requestPath === "midjourney.reference_mode") {
    return t(`canvas.modelParams.midjourneyReferenceModes.${token}`, {
      defaultValue: String(option),
    });
  }
  return String(option);
}

interface ThemedMultiSelectProps {
  item: MediaModelParameterDefinition;
  value: unknown[];
  onChange: (value: unknown[]) => void;
}

function ThemedMultiSelect({ item, value, onChange }: ThemedMultiSelectProps) {
  const selected = new Set(value.map(optionToken));
  return (
    <div className="flex flex-wrap gap-1.5">
      {(item.options ?? []).map((option) => {
        const token = optionToken(option);
        const checked = selected.has(token);
        return (
          <button
            key={token}
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={String(option)}
            className={`rounded-md border px-2 py-1 text-xs transition-colors ${
              checked
                ? "border-primary/50 bg-primary/15 text-text-dark"
                : "border-white/10 bg-bg-dark text-text-muted hover:border-white/20 hover:text-text-dark"
            }`}
            onClick={() => {
              const next = checked
                ? value.filter((current) => optionToken(current) !== token)
                : [...value, option];
              onChange(next);
            }}
          >
            {String(option)}
          </button>
        );
      })}
    </div>
  );
}

const MODE_ALIASES: Record<string, string> = {
  ...GEN_MODE_TO_CATALOG_MODE,
};

export function filterMediaModelParamsForMode(
  parameters: MediaModelParameterDefinition[] | undefined,
  values: Record<string, unknown> | undefined,
  mode: string,
): Record<string, unknown> {
  const normalizedMode = MODE_ALIASES[mode] ?? mode;
  const allowed = new Set(
    userSelectableMediaModelParameters(parameters, normalizedMode).map(
      (item) => item.key,
    ),
  );
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(([key]) => allowed.has(key)),
  );
}

function optionValue(
  item: MediaModelParameterDefinition,
  raw: string,
): unknown {
  if (!raw) return "";
  return (
    (item.options ?? []).find((option) => optionToken(option) === raw) ?? raw
  );
}

function optionToken(value: unknown): string {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${String(value)}`;
  if (typeof value === "boolean") return `boolean:${String(value)}`;
  return "";
}
