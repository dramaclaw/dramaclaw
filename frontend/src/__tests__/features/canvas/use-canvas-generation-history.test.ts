// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";

const fetchCanvasGenerationHistory = vi.hoisted(() => vi.fn());
const fetchNodeGenerationHistory = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock("@/api/ops", () => ({
  fetchCanvasGenerationHistory,
  fetchNodeGenerationHistory,
}));
vi.mock("@/lib/url-params", () => ({ readUrl }));

import { useCanvasGenerationHistory } from "@/features/canvas/hooks/useCanvasGenerationHistory";

describe("useCanvasGenerationHistory", () => {
  beforeEach(() => {
    fetchCanvasGenerationHistory.mockReset();
    fetchNodeGenerationHistory.mockReset();
    readUrl.mockReset();
    readUrl.mockReturnValue({ project: "p1", canvas: "c1" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the whole canvas history once (no per-node fan-out)", async () => {
    const records = [
      { id: "a", node_id: "kept", status: "completed", recorded_at: "2026-06-16T00:00:00Z" },
      // A record whose node no longer exists on the canvas still comes back —
      // that is the deleted-node-survives-in-history guarantee.
      { id: "b", node_id: "deleted", status: "completed", recorded_at: "2026-06-15T00:00:00Z" },
    ];
    fetchCanvasGenerationHistory.mockResolvedValue(records);

    const { result } = renderHook(() =>
      useCanvasGenerationHistory(["kept"], { enabled: true }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchCanvasGenerationHistory).toHaveBeenCalledTimes(1);
    expect(fetchCanvasGenerationHistory).toHaveBeenCalledWith("p1", "c1");
    expect(fetchNodeGenerationHistory).not.toHaveBeenCalled();
    expect(result.current.records).toEqual(records);
    expect(result.current.error).toBeNull();
  });

  it("falls back to per-node fan-out when the aggregate route is missing (404)", async () => {
    fetchCanvasGenerationHistory.mockRejectedValue(new ApiError("Not Found", 404));
    fetchNodeGenerationHistory.mockImplementation(async (_p, _c, nodeId: string) =>
      nodeId === "n1"
        ? [{ id: "r1", node_id: "n1", status: "completed", recorded_at: "2026-06-16T00:00:00Z" }]
        : [{ id: "r2", node_id: "n2", status: "completed", recorded_at: "2026-06-17T00:00:00Z" }],
    );

    const { result } = renderHook(() =>
      useCanvasGenerationHistory(["n1", "n2"], { enabled: true }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNodeGenerationHistory).toHaveBeenCalledTimes(2);
    // Merged + sorted newest-first across the fanned-out nodes.
    expect(result.current.records.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(result.current.error).toBeNull();
  });

  it("does not fetch when disabled", async () => {
    fetchCanvasGenerationHistory.mockResolvedValue([]);
    renderHook(() => useCanvasGenerationHistory(["n1"], { enabled: false }));
    await Promise.resolve();
    expect(fetchCanvasGenerationHistory).not.toHaveBeenCalled();
  });

  it("falls back to the default canvas id when the url has none", async () => {
    readUrl.mockReturnValue({ project: "p1", canvas: null });
    fetchCanvasGenerationHistory.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useCanvasGenerationHistory([], { enabled: true }),
    );

    await waitFor(() => expect(fetchCanvasGenerationHistory).toHaveBeenCalled());
    expect(fetchCanvasGenerationHistory).toHaveBeenCalledWith("p1", "default");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a non-404 error without falling back", async () => {
    fetchCanvasGenerationHistory.mockRejectedValue(new ApiError("boom", 500));

    const { result } = renderHook(() =>
      useCanvasGenerationHistory(["n1"], { enabled: true }),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(fetchNodeGenerationHistory).not.toHaveBeenCalled();
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.records).toEqual([]);
  });
});
