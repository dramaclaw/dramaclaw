// SPDX-License-Identifier: Elastic-2.0
import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapExit } from "./runtime/map-travel";
import { PIKO_MAP_TRANSITION_TIMING } from "./PikoMapTransition";
import { PikoWorldShell } from "./PikoWorldShell";
import * as localStorageQuota from "@/lib/localStorageQuota";
vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));

const travel = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./runtime/map-travel", () => ({ prepareMapTravel: travel.prepare }));
const map = vi.hoisted(() => ({ exit: (_exit: MapExit) => {}, report: (_state: "loading" | "ready" | "error") => {}, mounts: 0 }));
vi.mock("./PikoWorldCanvas", () => ({
  PikoWorldCanvas: ({ onLoadStateChange, showMayorHint, mayorHintVisible, mapId, spawnId, onExit }: { mapId: string; spawnId?: string; onExit?: (exit: MapExit) => void; onLoadStateChange: typeof map.report; showMayorHint?: boolean; mayorHintVisible?: boolean }) => {
    useEffect(() => { map.mounts++; map.report = onLoadStateChange; onLoadStateChange("loading"); }, [onLoadStateChange]);
    map.exit = exit => onExit?.(exit);
    return <div data-map={mapId} data-spawn={spawnId} data-testid="map-canvas" data-mayor-hint={String(showMayorHint)} data-question-visible={String(mayorHintVisible)} />;
  },
}));
vi.mock("./PikoResidentSelectorDialog", () => ({ PikoResidentSelectorDialog: () => null }));
vi.mock("./piko-loading", async (original) => ({
  ...await original<typeof import("./piko-loading")>(),
  preloadLoadingImages: () => Promise.resolve(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
beforeEach(() => { vi.useFakeTimers(); map.mounts = 0; travel.prepare.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

it("keeps map inert until automatic entry and covers the viewport with the map title", async () => {
  const { container } = render(<PikoWorldShell />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByTestId("map-canvas").parentElement).toHaveAttribute("inert");
  expect(container.querySelector("[data-map-id]")).toBeNull();
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-question-visible", "false");
  expect(screen.getByTestId("piko-loading-screen").closest("section")).toBeNull();
  act(() => { map.report("ready"); vi.advanceTimersByTime(3500); });
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.getByTestId("piko-loading-screen")).toBeInTheDocument();
  expect(screen.getByTestId("piko-entry-blackout")).toHaveAttribute("data-phase", "out");
  act(() => vi.advanceTimersByTime(250));
  expect(screen.queryByTestId("piko-loading-screen")).toBeNull();
  expect(screen.getByTestId("piko-entry-blackout")).toHaveAttribute("data-phase", "black");
  expect(container.querySelector("main > [data-map-id]")).toBeInTheDocument();
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-question-visible", "true");
  expect(container.querySelector("[data-map-id]")?.closest("section")).toBeNull();
  act(() => vi.advanceTimersByTime(100));
  expect(screen.getByTestId("piko-entry-blackout")).toHaveAttribute("data-phase", "in");
  act(() => vi.advanceTimersByTime(350));
  expect(screen.getByTestId("piko-entry-blackout")).toHaveAttribute("data-phase", "done");
  expect(screen.getByTestId("map-canvas").parentElement).not.toHaveAttribute("inert");
  expect(container.querySelector("main > [data-map-id]")).toHaveClass("fixed", "inset-0", "z-50");
  expect(map.mounts).toBe(1);
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-mayor-hint", "false");
  act(() => vi.advanceTimersByTime(PIKO_MAP_TRANSITION_TIMING.holdMs + PIKO_MAP_TRANSITION_TIMING.exitMs - 450 - 1));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-mayor-hint", "false");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-mayor-hint", "true");
  expect(container.querySelector("[data-map-id]")).toBeNull();
});

it("retries with a fresh canvas and a fresh minimum presentation interval", async () => {
  render(<PikoWorldShell />);
  await act(async () => { await Promise.resolve(); });
  act(() => map.report("error"));
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await act(async () => { await Promise.resolve(); });
  expect(map.mounts).toBe(2);
  act(() => map.report("ready"));
  expect(screen.getByTestId("piko-loading-screen")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(3500));
  act(() => vi.advanceTimersByTime(1500));
  act(() => vi.advanceTimersByTime(250));
  expect(screen.queryByTestId("piko-loading-screen")).toBeNull();
});

it("cancels a pending blackout on unmount", async () => {
  const { unmount } = render(<PikoWorldShell />);
  await act(async () => { await Promise.resolve(); });
  act(() => { map.report("ready"); vi.advanceTimersByTime(3500); });
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.getByTestId("piko-entry-blackout")).toHaveAttribute("data-phase", "out");
  unmount();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByTestId("piko-entry-blackout")).toBeNull();
});

async function enterWorld() {
  await act(async () => { await Promise.resolve(); });
  act(() => { map.report("ready"); vi.advanceTimersByTime(3500); });
  act(() => vi.advanceTimersByTime(1500));
  act(() => vi.advanceTimersByTime(250));
  act(() => vi.advanceTimersByTime(100));
  act(() => vi.advanceTimersByTime(350));
  act(() => vi.advanceTimersByTime(2500));
}
const marketExit: MapExit = { id: "to-artisan-market", targetMapId: "artisan-market",
  targetSpawnId: "welcome-courtyard-arrival", trigger: { id: "exit", points: [{x:30,y:245},{x:100,y:245},{x:100,y:295},{x:30,y:295}] } };

it("switches to the requested arrival and can recover to the source when target rendering fails", async () => {
  travel.prepare.mockResolvedValue({ destination: { mapId: "artisan-market", spawnId: "welcome-courtyard-arrival" },
    fallback: { mapId: "welcome-courtyard", spawnId: "artisan-market-arrival" } });
  render(<PikoWorldShell />);
  await enterWorld();
  await act(async () => { map.exit(marketExit); });
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map", "welcome-courtyard");
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByTestId("piko-travel-blackout")).toHaveAttribute("data-phase", "loading");
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map", "artisan-market");
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-spawn", "welcome-courtyard-arrival");
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-mayor-hint", "false");
  act(() => map.report("error"));
  expect(screen.getByText("匠作市集加载失败")).toBeInTheDocument();
  expect(screen.queryByText("正在加载匠作市集…")).toBeNull();
  act(() => vi.advanceTimersByTime(400));
  fireEvent.click(screen.getByRole("button", { name: "返回上一张地图" }));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map", "welcome-courtyard");
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-spawn", "artisan-market-arrival");
  act(() => map.report("ready"));
  act(() => vi.advanceTimersByTime(400));
  act(() => vi.advanceTimersByTime(2200));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-mayor-hint", "true");
});

it("keeps the source canvas when destination preparation fails", async () => {
  travel.prepare.mockRejectedValue(new Error("offline"));
  render(<PikoWorldShell />);
  await enterWorld();
  const mounts = map.mounts;
  await act(async () => { map.exit(marketExit); });
  expect(map.mounts).toBe(mounts);
  expect(travel.prepare.mock.calls[0][2].aborted).toBe(true);
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map", "welcome-courtyard");
});

it("holds black until the first frame and gives the title its full interval after fade-in", async () => {
  travel.prepare.mockResolvedValue({ destination: { mapId: "artisan-market", spawnId: "welcome-courtyard-arrival" },
    fallback: { mapId: "welcome-courtyard", spawnId: "artisan-market-arrival" } });
  render(<PikoWorldShell />);
  await enterWorld();
  await act(async () => { map.exit(marketExit); map.exit(marketExit); });
  expect(travel.prepare).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(299));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map", "welcome-courtyard");
  act(() => vi.advanceTimersByTime(1));
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.getByTestId("piko-travel-blackout")).toHaveAttribute("data-phase", "loading");
  act(() => map.report("ready"));
  expect(screen.getByTestId("piko-travel-blackout")).toHaveAttribute("data-phase", "in");
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByTestId("piko-travel-blackout")).toHaveAttribute("data-phase", "idle");
  act(() => vi.advanceTimersByTime(2199));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-mayor-hint", "false");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-mayor-hint", "true");
});

it("does not restart the fade when preparation finishes partway through it", async () => {
  let finish!: (result: unknown) => void;
  travel.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<PikoWorldShell />);
  await enterWorld();
  act(() => { map.exit(marketExit); });
  act(() => vi.advanceTimersByTime(200));
  await act(async () => finish({ destination: { mapId: "artisan-market" }, fallback: { mapId: "welcome-courtyard" } }));
  act(() => vi.advanceTimersByTime(100));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map", "artisan-market");
});

it("recovers from a stuck preparation and ignores its late response without replaying the source title", async () => {
  let finish!: (result: unknown) => void;
  travel.prepare.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { container } = render(<PikoWorldShell />);
  await enterWorld();
  act(() => { map.exit(marketExit); });
  act(() => vi.advanceTimersByTime(15000));
  expect(travel.prepare.mock.calls[0][2].aborted).toBe(true);
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByTestId("piko-travel-blackout")).toHaveAttribute("data-phase", "idle");
  expect(container.querySelector("[data-map-id]")).toBeNull();
  expect(screen.getByText("匠作市集加载失败")).toBeInTheDocument();
  await act(async () => finish({ destination: { mapId: "artisan-market" }, fallback: { mapId: "welcome-courtyard" } }));
  expect(screen.getByTestId("map-canvas")).toHaveAttribute("data-map", "welcome-courtyard");
});

it("aborts preparation and clears its deadline on unmount", async () => {
  travel.prepare.mockImplementation(() => new Promise(() => {}));
  const { unmount } = render(<PikoWorldShell />);
  await enterWorld();
  act(() => { map.exit(marketExit); });
  const signal = travel.prepare.mock.calls[0][2];
  unmount();
  expect(signal.aborted).toBe(true);
  // Shell intentionally fades BGM for 800ms during teardown.
  act(() => vi.advanceTimersByTime(800));
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves the same private request tray when switching maps repeatedly", async () => {
  render(<PikoWorldShell />);
  await enterWorld();
  act(() => vi.advanceTimersByTime(8000));
  const requests = screen.getAllByRole("region", { name: "私聊申请" });
  expect(requests).toHaveLength(2);
  for (const mapId of ["artisan-market", "wind-garden-gate", "artisan-market"]) {
    travel.prepare.mockResolvedValue({ destination: { mapId, spawnId: "arrival" },
      fallback: { mapId: "welcome-courtyard", spawnId: "artisan-market-arrival" } });
    await act(async () => map.exit({ ...marketExit, targetMapId: mapId }));
    expect(screen.queryByRole("region", { name: "私聊申请" })).toBeNull();
    expect(requests.every(node => node.isConnected)).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    expect(requests.every(node => node.isConnected)).toBe(true);
    expect(screen.queryByRole("region", { name: "私聊申请" })).toBeNull();
    act(() => map.report("ready"));
    act(() => vi.advanceTimersByTime(400));
    act(() => vi.advanceTimersByTime(2200));
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getAllByRole("region", { name: "私聊申请" })).toEqual(requests);
  }
});

it.each(["ready", "error"] as const)("records skyport discovery only after a successful first frame: %s", async state => {
  const save = vi.spyOn(localStorageQuota, "safeLocalStorageSet").mockReturnValue(true);
  try {
    render(<PikoWorldShell />);
    await enterWorld();
    travel.prepare.mockResolvedValue({ destination: { mapId: "whalesong-skyport", spawnId: "cloudtop-slope-arrival" },
      fallback: { mapId: "cloudtop-slope", spawnId: "whalesong-skyport-arrival" } });
    await act(async () => map.exit({ ...marketExit, targetMapId: "whalesong-skyport", action: "ascend" }));
    act(() => vi.advanceTimersByTime(300));
    expect(save).not.toHaveBeenCalledWith("piko-world:whalesong-skyport-discovered", "true");
    act(() => map.report(state));
    expect(save.mock.calls.some(([key]) => key === "piko-world:whalesong-skyport-discovered")).toBe(state === "ready");
  } finally { save.mockRestore(); }
});

vi.mock("./runtime/dog-world-session", () => ({ retainDogWorldSession: () => () => {} }));
