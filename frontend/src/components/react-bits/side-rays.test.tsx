// SPDX-License-Identifier: Elastic-2.0
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SideRays from "./side-rays";

const mocks = vi.hoisted(() => ({ render: vi.fn(), loseContext: vi.fn(), lost: false }));
vi.mock("ogl", () => ({
  Renderer: class {
    gl = {
      canvas: document.createElement("canvas"),
      clearColor: vi.fn(),
      isContextLost: () => mocks.lost,
      getExtension: () => ({ loseContext: mocks.loseContext }),
    };
    setSize = vi.fn();
    render = mocks.render;
  },
  Triangle: class {}, Program: class {}, Mesh: class {},
}));
const frames = new Map<number, FrameRequestCallback>();
let nextId = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); frames.clear(); mocks.lost = false;
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function draw() {
  act(() => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(100));
  });
}
async function mount() {
  const view = render(<SideRays />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  const canvas = view.container.querySelector("canvas")!;
  return { ...view, canvas };
}
it("shows only drawn pixels and hides the old canvas before page teardown", async () => {
  const { canvas, unmount } = await mount();
  expect(canvas.style.visibility).toBe("hidden");
  draw(); expect(canvas.style.visibility).toBe("visible");
  act(() => window.dispatchEvent(new Event("beforeunload")));
  expect(canvas.style.visibility).toBe("hidden"); expect(frames.size).toBe(0);
  act(() => window.dispatchEvent(new Event("pagehide")));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(frames.size).toBe(0);
  act(() => window.dispatchEvent(new Event("pageshow")));
  draw(); expect(canvas.style.visibility).toBe("visible");
  mocks.loseContext.mockImplementationOnce(() => {
    expect(canvas.isConnected).toBe(false);
    expect(canvas.style.visibility).toBe("hidden");
  });
  unmount(); expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it("resumes after cancelled navigation and rebuilds after context restoration", async () => {
  const { canvas, container } = await mount(); draw();
  act(() => window.dispatchEvent(new Event("beforeunload")));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  draw(); expect(canvas.style.visibility).toBe("visible");
  mocks.lost = true;
  const lost = new Event("webglcontextlost", { cancelable: true });
  act(() => canvas.dispatchEvent(lost));
  expect(lost.defaultPrevented).toBe(true);
  expect(canvas.style.visibility).toBe("hidden"); expect(frames.size).toBe(0);
  mocks.lost = false;
  act(() => canvas.dispatchEvent(new Event("webglcontextrestored")));
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  const replacement = container.querySelector("canvas")!;
  expect(replacement).not.toBe(canvas); expect(replacement.style.visibility).toBe("hidden");
  draw(); expect(replacement.style.visibility).toBe("visible");
});
