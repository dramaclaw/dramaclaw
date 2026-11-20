// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface ResolvedErrorContent {
  message: string;
  details?: string;
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function resolveErrorContent(error: unknown, fallbackMessage: string): ResolvedErrorContent {
  if (error instanceof Error) {
    const errorWithDetails = error as ErrorWithDetails;
    const details = stringifyUnknown(errorWithDetails.details);
    return {
      message: error.message?.trim() || fallbackMessage,
      details: details?.trim() || undefined,
    };
  }

  if (typeof error === 'string') {
    const content = error.trim();
    return {
      message: content || fallbackMessage,
      details: content || undefined,
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const candidate =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.details === 'string' && record.details) ||
      (typeof record.msg === 'string' && record.msg) ||
      '';
    const details = stringifyUnknown(record);
    return {
      message: candidate.trim() || fallbackMessage,
      details: details?.trim() || undefined,
    };
  }

  return { message: fallbackMessage };
}

