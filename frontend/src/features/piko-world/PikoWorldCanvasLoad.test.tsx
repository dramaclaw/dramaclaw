// SPDX-License-Identifier: Elastic-2.0
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PikoWorldCanvas } from "./PikoWorldCanvas";
import { loadPikoMapManifest } from "./runtime/map-package-loader";
import { PIKO_MAP_TRAVEL_TIMING } from "./piko-map-timing";

vi.mock("./runtime/map-package-loader", async original => ({
  ...await original<typeof import("./runtime/map-package-loader")>(),
  loadPikoMapManifest: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("aborts a stalled map load and exposes recovery instead of waiting forever", () => {
  vi.useFakeTimers();
  vi.mocked(loadPikoMapManifest).mockImplementation(() => new Promise(() => {}));
  const report = vi.fn();
  const { unmount } = render(<PikoWorldCanvas mapId="artisan-market" nickname="test" onLoadStateChange={report} />);
  const signal = vi.mocked(loadPikoMapManifest).mock.calls[0][1]!;
  act(() => vi.advanceTimersByTime(PIKO_MAP_TRAVEL_TIMING.renderTimeoutMs - 1));
  expect(report).toHaveBeenLastCalledWith("loading");
  act(() => vi.advanceTimersByTime(1));
  expect(signal.aborted).toBe(true);
  expect(report).toHaveBeenLastCalledWith("error");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
