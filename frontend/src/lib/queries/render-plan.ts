// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { jsonWithBackendError } from "@/lib/api-errors";
import { p } from "@/lib/api-path";
import type { ErrorResponse, OkResponse } from "@/types/api";
import type {
  PlanEntry,
  RenderExecuteResult,
  RenderPlan,
} from "@/types/render-plan";

export interface RenderPlanParams {
  beat_indices: number[];
  strategy: "location";
  force_one_by_one?: boolean;
  aspect_mode: string;
  image_generation_selection?: string;
  sketch_aspect_padding?: boolean;
}

export function useRenderPlan(project: string, episode: number) {
  return useMutation({
    mutationFn: (params: RenderPlanParams) =>
      api
        .post(
          p`api/v1/projects/${project}/episodes/${episode}/render/plan`,
          { json: params },
        )
        .json<OkResponse<RenderPlan> | ErrorResponse>(),
  });
}

export interface RenderExecuteParams {
  plan: PlanEntry[];
  plan_hash: string;
  input_fingerprint: string;
  strategy: "location";
  aspect_mode: string;
  force_one_by_one?: boolean;
  image_generation_selection?: string;
  sketch_aspect_padding?: boolean;
  custom_plan?: boolean;
  beat_indices: number[];
}

export function useRenderExecute(project: string, episode: number) {
  return useMutation({
    mutationFn: (params: RenderExecuteParams) =>
      jsonWithBackendError<OkResponse<RenderExecuteResult> | ErrorResponse>(
        api.post(
          p`api/v1/projects/${project}/episodes/${episode}/render/execute`,
          { json: params, throwHttpErrors: false },
        ),
      ),
  });
}
