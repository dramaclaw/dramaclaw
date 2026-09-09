// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ToolFieldSchema, ToolOptions } from '@/features/canvas/tools';
import { UiInput, UiSelect } from '@/components/ui';
import type { FormToolEditorProps } from './types';

function readTextOption(options: ToolOptions, key: string): string {
  const value = options[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function readNumberOption(options: ToolOptions, key: string): number {
  const value = options[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function FormToolEditor({ fields, options, onOptionsChange }: FormToolEditorProps) {
  const { t } = useTranslation();
  const updateOption = useCallback(
    (key: string, value: string | number) => {
      onOptionsChange({
        ...options,
        [key]: value,
      });
    },
    [onOptionsChange, options]
  );

  const renderField = useCallback(
    (field: ToolFieldSchema) => {
      if (field.type === 'text') {
        return (
          <UiInput
            type="text"
            value={readTextOption(options, field.key)}
            onChange={(event) => updateOption(field.key, event.target.value)}
            placeholder={field.placeholder}
          />
        );
      }

      if (field.type === 'number') {
        return (
          <UiInput
            type="number"
            value={readNumberOption(options, field.key)}
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            onChange={(event) => updateOption(field.key, Number(event.target.value))}
          />
        );
      }

      if (field.type === 'color') {
        return (
          <input
            type="color"
            value={readTextOption(options, field.key)}
            onChange={(event) => updateOption(field.key, event.target.value)}
            className="h-10 w-full rounded-lg border border-[rgba(255,255,255,0.12)] bg-bg-dark/90 p-1"
          />
        );
      }

      return (
        <UiSelect
          value={readTextOption(options, field.key)}
          onChange={(event) => updateOption(field.key, event.target.value)}
          className="h-10 border-[rgba(255,255,255,0.12)] bg-bg-dark/90 text-sm"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.labelKey ? t(option.labelKey) : option.label}
            </option>
          ))}
        </UiSelect>
      );
    },
    [options, t, updateOption]
  );

  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <div key={field.key}>
          <label className="mb-1 block text-xs text-text-muted">{t(field.labelKey)}</label>
          {renderField(field)}
        </div>
      ))}
    </div>
  );
}
