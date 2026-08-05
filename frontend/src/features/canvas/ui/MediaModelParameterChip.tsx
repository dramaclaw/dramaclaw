import { SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { MediaModelParameterDefinition } from "@/api/ops";
import { NODE_TEXT_CONTROL_TRIGGER_CLASS } from "@/features/canvas/ui/nodeControlStyles";

interface Props {
  parameters?: MediaModelParameterDefinition[];
  values?: Record<string, unknown>;
  mode?: string;
  onChange: (values: Record<string, unknown>) => void;
}

export function MediaModelParameterChip({ parameters, values = {}, mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(
    () => (parameters ?? []).filter((item) => {
      if (!item.modes?.length) return true;
      const normalizedMode = mode ? MODE_ALIASES[mode] ?? mode : "";
      return Boolean(mode && (item.modes.includes(mode) || item.modes.includes(normalizedMode)));
    }),
    [mode, parameters],
  );

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [open]);

  if (!visible.length) return null;
  const setValue = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title="模型参数"
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span>模型参数</span>
      </button>
      {open && (
        <div
          className="nodrag nowheel absolute bottom-full left-0 z-50 mb-2 w-72 space-y-3 rounded-md border border-border-dark bg-bg-panel p-3 shadow-xl"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {visible.map((item) => {
            const value = values[item.key] ?? item.default ?? (item.control === "switch" ? false : "");
            return (
              <label key={item.key} className="block space-y-1.5">
                <span className="block text-xs text-text-muted">{item.label || item.key}</span>
                {item.control === "switch" ? (
                  <input type="checkbox" checked={Boolean(value)} onChange={(e) => setValue(item.key, e.target.checked)} />
                ) : item.control === "select" || item.control === "multiselect" ? (
                  <select
                    multiple={item.control === "multiselect"}
                    className="min-h-8 w-full rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
                    value={
                      item.control === "multiselect" && Array.isArray(value)
                        ? value.map(optionToken)
                        : optionToken(value)
                    }
                    onChange={(e) => setValue(item.key, item.control === "multiselect"
                      ? Array.from(e.target.selectedOptions, (option) => optionValue(item, option.value))
                      : optionValue(item, e.target.value))}
                  >
                    {!item.required && item.control !== "multiselect" && <option value="">默认</option>}
                    {(item.options ?? []).map((option) => {
                      const token = optionToken(option);
                      return <option key={token} value={token}>{String(option)}</option>;
                    })}
                  </select>
                ) : (
                  <input
                    type={item.control === "number" ? "number" : "text"}
                    className="h-8 w-full rounded border border-border-dark bg-bg-dark px-2 text-xs text-text-dark"
                    value={String(value)}
                    min={item.min}
                    max={item.max}
                    step={item.step}
                    onChange={(e) => setValue(
                      item.key,
                      item.control === "number"
                        ? (e.target.value === "" ? undefined : Number(e.target.value))
                        : e.target.value,
                    )}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MODE_ALIASES: Record<string, string> = {
  textToVideo: "text_to_video",
  imageToVideo: "image_reference",
  firstLastFrame: "first_last_frame",
  imageReference: "image_reference",
  allReference: "all_reference",
  videoEdit: "video_edit",
};

export function filterMediaModelParamsForMode(
  parameters: MediaModelParameterDefinition[] | undefined,
  values: Record<string, unknown> | undefined,
  mode: string,
): Record<string, unknown> {
  const normalizedMode = MODE_ALIASES[mode] ?? mode;
  const allowed = new Set(
    (parameters ?? [])
      .filter((item) => !item.modes?.length || item.modes.includes(normalizedMode))
      .map((item) => item.key),
  );
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(([key]) => allowed.has(key)),
  );
}

function optionValue(item: MediaModelParameterDefinition, raw: string): unknown {
  if (!raw) return "";
  return (item.options ?? []).find((option) => optionToken(option) === raw) ?? raw;
}

function optionToken(value: unknown): string {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${String(value)}`;
  if (typeof value === "boolean") return `boolean:${String(value)}`;
  return "";
}
