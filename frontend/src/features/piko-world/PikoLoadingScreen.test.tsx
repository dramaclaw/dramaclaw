// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { PikoLoadingScreen } from "./PikoLoadingScreen";
vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));
import { loadingDisplayProgress, PIKO_LOADING_SCENES, PIKO_LOADING_BACKGROUNDS, PIKO_LOADING_CONTROLS, preloadLoadingImages } from "./piko-loading";

vi.mock("./piko-loading", async (original) => ({
  ...await original<typeof import("./piko-loading")>(),
  preloadLoadingImages: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(preloadLoadingImages).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function settle() { await act(async () => { await Promise.resolve(); }); }

describe("Piko loading screen", () => {
  it("binds every background to its own localized scene line", () => {
    for (const lang of ["zh", "en"]) {
      const scenes = JSON.parse(readFileSync(`public/locales/${lang}/translation.json`, "utf8")).pikoWorld.loadingScenes;
      const lines = PIKO_LOADING_SCENES.map(({ id }) => {
        expect(scenes[id].title).toBeTruthy();
        expect(scenes[id].line).toBeTruthy();
        return scenes[id].line;
      });
      expect(new Set(lines).size).toBe(8);
    }
  });
  it("cancels automatic entry when an error arrives during the final fill", async () => {
    const enter = vi.fn();
    const { rerender } = render(<PikoLoadingScreen loadState="ready" onEnter={enter} onRetry={vi.fn()} />);
    await settle();
    act(() => vi.advanceTimersByTime(3500));
    rerender(<PikoLoadingScreen loadState="error" onEnter={enter} onRetry={vi.fn()} />);
    act(() => vi.advanceTimersByTime(500));
    expect(enter).not.toHaveBeenCalled();
  });
  it("ships exactly the selected eight backgrounds and the two active controls", () => {
    expect(PIKO_LOADING_BACKGROUNDS).toHaveLength(8);
    for (const path of [...PIKO_LOADING_BACKGROUNDS, ...Object.values(PIKO_LOADING_CONTROLS)]) {
      expect(existsSync(`public${path}`), path).toBe(true);
    }
  });
  it("holds fast loads for 3.5 seconds then enters automatically without buttons", async () => {
    const enter = vi.fn();
    render(<PikoLoadingScreen loadState="ready" onEnter={enter} onRetry={vi.fn()} />);
    await settle();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveClass("aspect-[1365/118]", "w-[min(400px,88%)]");
    expect(screen.getByRole("progressbar").parentElement).toHaveClass("items-center");
    expect(screen.getByTestId("piko-loading-screen")).toHaveClass("fixed", "inset-0");
    act(() => vi.advanceTimersByTime(3450));
    expect(enter).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(enter).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1499));
    expect(enter).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(enter).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(5000));
    expect(enter).toHaveBeenCalledOnce();
  });
  it("never completes simulated progress before actual map readiness", async () => {
    const props = { onEnter: vi.fn(), onRetry: vi.fn() };
    const { rerender } = render(<PikoLoadingScreen loadState="loading" {...props} />);
    await settle();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "90");
    expect(props.onEnter).not.toHaveBeenCalled();
    rerender(<PikoLoadingScreen loadState="ready" {...props} />);
    act(() => vi.advanceTimersByTime(1500));
    expect(props.onEnter).toHaveBeenCalledOnce();
  });
  it("starts minimum presentation only once artwork has loaded", async () => {
    const enter = vi.fn();
    let resolve!: () => void;
    vi.mocked(preloadLoadingImages).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    render(<PikoLoadingScreen loadState="ready" onEnter={enter} onRetry={vi.fn()} />);
    act(() => vi.advanceTimersByTime(4000));
    expect(enter).not.toHaveBeenCalled();
    await act(async () => resolve());
    act(() => vi.advanceTimersByTime(3500));
    act(() => vi.advanceTimersByTime(1500));
    expect(enter).toHaveBeenCalledOnce();
  });
  it("shows conventional recovery buttons on map error", async () => {
    const retry = vi.fn();
    render(<PikoLoadingScreen loadState="error" onEnter={vi.fn()} onRetry={retry} />);
    await settle();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入 Piko 小镇" })).toBeNull();
    expect(screen.getByRole("button", { name: "返回工作台" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it("recovers from missing artwork and stalled map loads", async () => {
    vi.mocked(preloadLoadingImages).mockRejectedValueOnce(new Error("404"));
    const { unmount } = render(<PikoLoadingScreen loadState="ready" onEnter={vi.fn()} onRetry={vi.fn()} />);
    await settle();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    unmount();
    render(<PikoLoadingScreen loadState="loading" onEnter={vi.fn()} onRetry={vi.fn()} />);
    await settle();
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  it("aborts pending asset work when leaving and starts fresh on remount", async () => {
    const { unmount } = render(<PikoLoadingScreen loadState="ready" onEnter={vi.fn()} onRetry={vi.fn()} />);
    const calls = vi.mocked(preloadLoadingImages).mock.calls;
    const signal = calls[calls.length - 1][1];
    await settle();
    act(() => vi.advanceTimersByTime(3500));
    unmount();
    expect(signal.aborted).toBe(true);
    render(<PikoLoadingScreen loadState="ready" onEnter={vi.fn()} onRetry={vi.fn()} />);
    await settle();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });
  it("keeps illustrative progress bounded", () => {
    expect(loadingDisplayProgress(-1, false)).toBe(0);
    expect(loadingDisplayProgress(90000, false)).toBe(90);
    expect(loadingDisplayProgress(3499, true)).toBeLessThan(100);
    expect(loadingDisplayProgress(3500, true)).toBe(100);
  });
});
