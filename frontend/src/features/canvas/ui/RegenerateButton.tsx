// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface RegenerateButtonProps {
  onClick: () => void;
  /** Shows a spinner + disables the button while a (re)generation is in flight. */
  busy?: boolean;
  disabled?: boolean;
  label?: string;
  title?: string;
  className?: string;
}

/**
 * Shared 重新生成 entry used by failure states across canvas generation nodes
 * (ImageGen / ExportImage / Storyboard / Video / Audio). Lives on `.nodrag` so
 * clicking it inside a node body doesn't start a canvas drag, and stops both
 * pointerdown + click from bubbling to the node's select/drag handlers.
 */
export function RegenerateButton({
  onClick,
  busy = false,
  disabled = false,
  label,
  title,
  className = '',
}: RegenerateButtonProps) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t('canvas.common.regenerate');
  const isDisabled = busy || disabled;
  return (
    <button
      type="button"
      disabled={isDisabled}
      title={title ?? resolvedLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (isDisabled) return;
        onClick();
      }}
      className={`nodrag inline-flex items-center justify-center gap-1.5 rounded-full border border-red-400/45 bg-red-500/15 px-3 py-1 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" />
      )}
      <span>{label}</span>
    </button>
  );
}
