// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isRecord } from '@/features/freezone/canvasCommandEnvelope';
import {
  canvasCreationQuota, describeCanvases, planCanvasCreation,
  type CanvasSummaryForDisplay, type PlanCanvasCreationInput,
} from '../core/canvasCreation';
import { invalidRequest } from './requestPayload';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

function parseCanvases(value: unknown): CanvasSummaryForDisplay[] {
  if (!Array.isArray(value) || !value.every(isRecord)) invalidRequest('canvases must be an array of records');
  return value as unknown as CanvasSummaryForDisplay[];
}

function parseLocale(env: unknown): string | undefined {
  if (env === undefined) return undefined;
  if (!isRecord(env) || (env.locale !== undefined && typeof env.locale !== 'string')) invalidRequest('Invalid canvas creation environment');
  return env.locale;
}

export async function servePlanCanvasCreation(payload: unknown) {
  if (!isRecord(payload) || typeof payload.project_id !== 'string' || typeof payload.name !== 'string' ||
      typeof payload.request_id !== 'string' || (payload.save_source !== 'manual_save' && payload.save_source !== 'agent_create') ||
      (payload.creator_username !== undefined && payload.creator_username !== null && typeof payload.creator_username !== 'string')) {
    invalidRequest('Invalid canvas creation request');
  }
  let origin: PlanCanvasCreationInput['origin'];
  if (payload.origin !== undefined) {
    if (!isRecord(payload.origin) || typeof payload.origin.chat_canvas_id !== 'string' || typeof payload.origin.turn_id !== 'string') {
      invalidRequest('Invalid canvas creation origin');
    }
    origin = { chatCanvasId: payload.origin.chat_canvas_id, turnId: payload.origin.turn_id };
  }
  const input: PlanCanvasCreationInput = {
    projectId: payload.project_id,
    name: payload.name,
    creatorUsername: payload.creator_username,
    canvases: payload.canvases == null ? null : parseCanvases(payload.canvases),
    requestId: payload.request_id,
    saveSource: payload.save_source,
    origin,
  };
  const locale = parseLocale(payload.env);
  return runServerRequest(locale, async () => {
    const translate = await createServerTranslate(locale);
    return planCanvasCreation(input, { translate });
  });
}

export async function serveDescribeCanvases(payload: unknown) {
  if (!isRecord(payload)) invalidRequest('Invalid canvas description request');
  const canvases = parseCanvases(payload.canvases);
  const viewer = payload.viewer === undefined ? {} : payload.viewer;
  if (!isRecord(viewer) ||
      (viewer.username !== undefined && viewer.username !== null && typeof viewer.username !== 'string') ||
      (viewer.chat_canvas_id !== undefined && viewer.chat_canvas_id !== null && typeof viewer.chat_canvas_id !== 'string')) {
    invalidRequest('Invalid canvas viewer');
  }
  const username = viewer.username;
  const chatCanvasId = viewer.chat_canvas_id;
  const locale = parseLocale(payload.env);
  return runServerRequest(locale, async () => {
    const translate = await createServerTranslate(locale);
    return {
      canvases: describeCanvases(canvases, { username, chatCanvasId }, { translate }),
      quota: canvasCreationQuota(canvases, username),
    };
  });
}
