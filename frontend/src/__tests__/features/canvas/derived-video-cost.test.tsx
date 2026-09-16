import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), quote: vi.fn() }));
vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", () => ({
  useFreezoneVideoModels: mocks.catalog,
}));
vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: mocks.quote,
}));

import { useDerivedVideoCost } from "@/features/canvas/ui/ImageDerivedActions";

describe("GIF video model availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.quote.mockReturnValue({ isLoading: false, error: null });
  });

  it.each(["newapi_seedance-2.0-fast", "seedance-2.0-fast"])(
    "resolves Seedance Fast with catalog ID %s",
    (id) => {
      mocks.catalog.mockReturnValue({ models: [{
        id, catalogId: id, apiModel: "newapi_seedance-2.0-fast",
      }] });
      const { result } = renderHook(() => useDerivedVideoCost());
      expect(result.current.available).toBe(true);
      expect(mocks.quote).toHaveBeenLastCalledWith(
        "feature", "freezone.video_generate",
        expect.objectContaining({ params: expect.objectContaining({
          catalog_id: id, video_backend: "newapi_seedance-2.0-fast",
        }) }),
      );
    },
  );

  it("does not substitute another model when Seedance Fast is absent", () => {
    mocks.catalog.mockReturnValue({ models: [{
      id: "seedance-2.0", apiModel: "newapi_seedance-2.0",
    }] });
    const { result } = renderHook(() => useDerivedVideoCost());
    expect(result.current.available).toBe(false);
    expect(mocks.quote).toHaveBeenLastCalledWith("feature", null, expect.any(Object));
  });
});
