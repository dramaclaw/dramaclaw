import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasImagePreviewButton } from "@/features/canvas/ui/CanvasImagePreviewButton";

const { openImageViewer } = vi.hoisted(() => ({ openImageViewer: vi.fn() }));
vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ openImageViewer }),
}));

describe("CanvasImagePreviewButton", () => {
  it("opens the entire source image without bubbling to canvas actions", () => {
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    const onDoubleClick = vi.fn();
    render(
      <div
        onClick={onClick}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      >
        <CanvasImagePreviewButton imageUrl="/original-grid.png" />
      </div>,
    );
    const button = screen.getByRole("button", { name: "整图预览" });
    expect(button).toHaveClass("z-30", "nodrag", "nopan");
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    fireEvent.doubleClick(button);
    expect(openImageViewer).toHaveBeenCalledExactlyOnceWith(
      "/original-grid.png",
      ["/original-grid.png"],
    );
    expect(onClick).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});
