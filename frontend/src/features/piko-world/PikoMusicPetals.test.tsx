import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PikoMusicPetals } from "./PikoMusicPetals";

it("emits during playback, drains on pause, and cancels on close", () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5).mockReturnValueOnce(0);
  const motion = { matches: false };
  vi.stubGlobal("matchMedia", () => motion);
  const context = { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), drawImage: vi.fn(), globalAlpha: 1 };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  let tick: FrameRequestCallback = () => {};
  let ready: (() => void) | null = null;
  vi.stubGlobal("Image", class {
    naturalWidth = 1254; naturalHeight = 1254;
    set onload(fn: (() => void) | null) { ready = fn; }
    src = "";
  });
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation(fn => { tick = fn; return 1; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  try {
    const { rerender, unmount } = render(<PikoMusicPetals emitting />);
    act(() => { ready?.(); tick(500); tick(1000); });
    expect(context.drawImage).toHaveBeenCalled();
    rerender(<PikoMusicPetals emitting={false} />);
    context.drawImage.mockClear();
    act(() => tick(1500));
    expect(context.drawImage).toHaveBeenCalled();
    const positions = context.translate.mock.calls;
    expect(positions.some(([x]) => x > 414)).toBe(true);
    expect(positions.some(([x]) => x < 414)).toBe(true);
    context.drawImage.mockClear();
    act(() => tick(4000));
    expect(context.drawImage).not.toHaveBeenCalled();
    rerender(<PikoMusicPetals emitting />);
    motion.matches = true;
    act(() => tick(4500));
    expect(context.drawImage).not.toHaveBeenCalled();
    unmount();
    expect(cancel).toHaveBeenCalledWith(1);
    expect(ready).toBeNull();
  } finally { random.mockRestore(); getContext.mockRestore(); request.mockRestore(); cancel.mockRestore(); vi.unstubAllGlobals(); }
});
