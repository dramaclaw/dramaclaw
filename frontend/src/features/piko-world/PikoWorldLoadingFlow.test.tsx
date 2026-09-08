// SPDX-License-Identifier: Elastic-2.0
import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PikoWorldShell } from "./PikoWorldShell";
vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));

const map = vi.hoisted(() => ({ report: (_state: "loading" | "ready" | "error") => {}, mounts: 0 }));
vi.mock("./PikoWorldCanvas", () => ({
  PikoWorldCanvas: ({ onLoadStateChange, showMayorHint, mayorHintVisible }: { onLoadStateChange: typeof map.report; showMayorHint?: boolean; mayorHintVisible?: boolean }) => {
    useEffect(() => { map.mounts++; map.report = onLoadStateChange; onLoadStateChange("loading"); }, [onLoadStateChange]);
    return <div data-testid="map-canvas" data-mayor-hint={String(showMayorHint)} data-question-visible={String(mayorHintVisible)} />;
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
beforeEach(() => { vi.useFakeTimers(); map.mounts = 0; });
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
  act(() => vi.advanceTimersByTime(3349));
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
