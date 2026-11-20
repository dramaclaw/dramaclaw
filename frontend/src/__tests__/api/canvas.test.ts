// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall, apiCallEnvelope } from "@/api/client";
import {
  buildProjectionFromPreset,
  admitFreezoneRecipeResult,
  createFreezoneCanvas,
  getFreezoneCanvas,
  getProjectionStatuses,
  generateClientSaveId,
  isOwnClientSaveId,
  listFreezoneWorkflowRuns,
  putFreezoneCanvas,
} from "@/api/canvas";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  // 画布详情走整信封:`foreign_media` 挂在 `data` 同级,只解一层的 apiCall 会丢掉它。
  apiCallEnvelope: vi.fn(),
}));

describe("canvas client save ids", () => {
  it("recognizes generated ids and rejects other values", () => {
    const id = generateClientSaveId();
    expect(isOwnClientSaveId(id)).toBe(true);
    expect(isOwnClientSaveId("another-tab-save")).toBe(false);
    expect(isOwnClientSaveId(null)).toBe(false);
    expect(isOwnClientSaveId(undefined)).toBe(false);
    expect(isOwnClientSaveId(1)).toBe(false);
    expect(isOwnClientSaveId({ id })).toBe(false);
  });

  it("forgets an id only after 100 newer ids", () => {
    const oldest = generateClientSaveId();
    const newer = Array.from({ length: 99 }, () => generateClientSaveId());
    expect(isOwnClientSaveId(oldest)).toBe(true);
    const newest = generateClientSaveId();
    expect(isOwnClientSaveId(oldest)).toBe(false);
    expect(newer.every(isOwnClientSaveId)).toBe(true);
    expect(isOwnClientSaveId(newest)).toBe(true);
  });
});

describe("canvas projection api", () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCallEnvelope).mockReset();
  });

  it('admits a standalone Recipe result using the existing product endpoint', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({ operation_id: 'op' });
    expect(await admitFreezoneRecipeResult('project a', 'canvas', 'html', 'recipe', 'attempt'))
      .toEqual({ operation_id: 'op' });
    expect(apiCall).toHaveBeenCalledWith('projects/project%20a/freezone/agent-product-operations', {
      method: 'POST', json: {
        product_kind: 'recipe_result', generation_session_id: 'attempt', canvas_id: 'canvas',
        artifact_id: 'html', normalized_inputs_hash: 'attempt',
        metadata: { recipe_id: 'recipe', generation_attempt_id: 'attempt' },
      },
    });
  });

  it("passes abort signals through canvas detail GETs", async () => {
    const controller = new AbortController();
    vi.mocked(apiCallEnvelope).mockResolvedValueOnce({
      ok: true,
      data: {
        nodes: [],
        edges: [],
        revision: 4,
      },
    });

    await getFreezoneCanvas("project-a", "user_eric", {
      signal: controller.signal,
    });

    expect(apiCallEnvelope).toHaveBeenCalledWith(
      "projects/project-a/freezone/canvases/user_eric",
      { signal: controller.signal },
    );
  });

  it("builds a preset projection graph without a target canvas", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      projection_key: "beat:1:4",
      facts_signature: "sig",
      nodes: [],
      edges: [],
      metadata: {},
    });

    await buildProjectionFromPreset("project-a", {
      scope: "beat",
      episode: 1,
      beat: 4,
      projection_key: "beat:1:4",
      base_revision: 0,
    });

    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-a/freezone/projections:build-from-preset",
      {
        method: "POST",
        json: {
          scope: "beat",
          episode: 1,
          beat: 4,
          projection_key: "beat:1:4",
          base_revision: 0,
        },
      },
    );
  });

  it("posts projection status request to a canvas", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      canvas_id: "user_eric",
      revision: 8,
      projections: [
        {
          projection_key: "beat:1:4",
          stale: true,
          stored_facts_signature: "old",
          current_facts_signature: "new",
        },
      ],
    });

    const result = await getProjectionStatuses("project-a", "user_eric", ["beat:1:4"]);

    expect(result.projections[0].stale).toBe(true);
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-a/freezone/canvases/user_eric/projections:status",
      {
        method: "POST",
        json: { projection_keys: ["beat:1:4"] },
      },
    );
  });

  it("persists canvas changes with a PUT request body", async () => {
    const payload = {
      nodes: [{ id: "n1" }],
      edges: [],
      base_revision: 7,
      client_save_id: "save-1",
    };
    vi.mocked(apiCall).mockResolvedValueOnce({
      saved: true,
      revision: 8,
    });

    await putFreezoneCanvas("project-a", "user_eric", payload);

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiCall).mock.calls[0]).toEqual([
      "projects/project-a/freezone/canvases/user_eric",
      {
        method: "PUT",
        json: payload,
      },
    ]);
  });

  it("creates a canvas through the server create route", async () => {
    const response = {
      status: "created",
      canvas_id: "canvas_story_lab_abc123",
      display_name: "Story lab",
      revision: 1,
    };
    vi.mocked(apiCall).mockResolvedValueOnce(response);

    const result = await createFreezoneCanvas("project a", {
      name: "Story lab", request_id: "req-1", locale: "en",
    });

    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiCall).mock.calls[0]).toEqual([
      "projects/project%20a/freezone/canvases:create",
      { method: "POST", json: { name: "Story lab", request_id: "req-1", locale: "en" } },
    ]);
    expect(result).toBe(response);
  });

  it("coalesces concurrent workflow-run polling for the same canvas", async () => {
    let resolveRequest: (value: { runs: [] }) => void = () => {
      throw new Error("workflow-run request resolver was not initialized");
    };
    vi.mocked(apiCall).mockImplementationOnce(
      () =>
        new Promise<{ runs: [] }>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const first = listFreezoneWorkflowRuns("project-a", "canvas-a");
    const second = listFreezoneWorkflowRuns("project-a", "canvas-a");

    expect(first).toBe(second);
    expect(apiCall).toHaveBeenCalledTimes(1);

    resolveRequest({ runs: [] });
    await first;

    vi.mocked(apiCall).mockResolvedValueOnce({ runs: [] });
    await listFreezoneWorkflowRuns("project-a", "canvas-a");
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it("clears the workflow-run request lock after a failed request", async () => {
    vi.mocked(apiCall)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ runs: [] });

    await expect(
      listFreezoneWorkflowRuns("project-b", "canvas-b"),
    ).rejects.toThrow("timeout");
    await listFreezoneWorkflowRuns("project-b", "canvas-b");

    expect(apiCall).toHaveBeenCalledTimes(2);
  });
});
