// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrevizObject } from "@/features/previz/domain/objects";
import type { PrevizCharacterDraft } from "@/features/previz/domain/characterDraft";
import type { PrevizObject } from "@/features/previz/domain/scene";
import {
  canvasToWorld,
  sceneTopDownBounds,
  topDownView,
  worldToCanvas,
} from "@/features/previz/domain/topDownMap";
import { PREVIZ_TOP_DOWN_PICKER_SIZE } from "@/features/previz/ui/PrevizTopDownPicker";
import { PrevizCharacterCreateDialog } from "@/features/previz/ui/PrevizCharacterCreateDialog";

// 回显 key，与 previz-camera-create-dialog.test.tsx 同一个做法：断言里出现的是 key
// 本身，改一句中文文案不该让这个文件变红。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

type DialogProps = ComponentProps<typeof PrevizCharacterCreateDialog>;

/** 只有 x/z 进俯视映射，y 一律给非零值，免得用例在「其实读的是 y」上蒙混过关。 */
function characterAt(x: number, z: number, color: string): PrevizObject {
  const created = createPrevizObject("character", []);
  return {
    ...created,
    color,
    transform: { ...created.transform, position: [x, 1.5, z] },
  };
}

function setup(overrides: Partial<DialogProps> = {}) {
  const onCreate = vi.fn();
  const onClose = vi.fn();
  const onRenderPreview = vi.fn();
  const props: DialogProps = {
    open: true,
    objects: [],
    onRenderPreview,
    onCreate,
    onClose,
    ...overrides,
  };
  const view = render(<PrevizCharacterCreateDialog {...props} />);
  return { ...view, onCreate, onClose, onRenderPreview, objects: props.objects };
}

/**
 * jsdom 不排版，`getBoundingClientRect()` 四个数全是 0，而选位图是按 rect 换算落点的
 * ——不塞一个真尺寸进去，鼠标那条路在这里根本走不到。做法与
 * previz-top-down-picker.test.tsx 的 `stubRect` 一致。
 */
function stubPickerRect(): void {
  const canvas = screen.getByTestId("top-down-picker");
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: PREVIZ_TOP_DOWN_PICKER_SIZE.width,
      height: PREVIZ_TOP_DOWN_PICKER_SIZE.height,
      right: PREVIZ_TOP_DOWN_PICKER_SIZE.width,
      bottom: PREVIZ_TOP_DOWN_PICKER_SIZE.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * 组件里那张视图的复算。断言不抄组件的算式，而是走同一份 domain 函数：这样测的是
 * 「对话框有没有把选位图接对」，映射本身对不对由 top-down-map.test.ts 管。
 * jsdom 的 devicePixelRatio 是 1，所以位图尺寸就是 CSS 尺寸。
 */
function viewFor(objects: readonly PrevizObject[]) {
  return topDownView(
    sceneTopDownBounds(objects),
    PREVIZ_TOP_DOWN_PICKER_SIZE.width,
    PREVIZ_TOP_DOWN_PICKER_SIZE.height,
  );
}

/** 在选位图上点一下，返回这一下按 domain 映射应该得到的世界 XZ。 */
function pickAt(
  objects: readonly PrevizObject[],
  clientX: number,
  clientY: number,
): readonly [number, number] {
  stubPickerRect();
  fireEvent.click(screen.getByRole("button", { name: /previz\.characterCreate\.pickHint/ }), {
    // `detail: 1` 才走坐标那条路：0 是键盘 / 合成点击，选位图会回落到取景中心。
    detail: 1,
    clientX,
    clientY,
  });
  return canvasToWorld(viewFor(objects), [clientX, clientY]);
}

function createButton(): HTMLElement {
  return screen.getByRole("button", { name: "previz.characterCreate.create" });
}

/** 最后一次 onCreate 收到的草稿。 */
function created(onCreate: ReturnType<typeof vi.fn>): PrevizCharacterDraft {
  return onCreate.mock.calls[onCreate.mock.calls.length - 1]?.[0] as PrevizCharacterDraft;
}

/** 最后一次预览请求收到的草稿。 */
function previewed(onRenderPreview: ReturnType<typeof vi.fn>): PrevizCharacterDraft {
  const calls = onRenderPreview.mock.calls;
  return calls[calls.length - 1]?.[1] as PrevizCharacterDraft;
}

describe("PrevizCharacterCreateDialog", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // 没选位的草稿连类型都进不了 `characterDraftOverrides`，闸门漏掉的表现不是报错，
  // 而是人静静地站在世界原点——用户以为自己点的那一下没生效。
  it("keeps create disabled until a spot has been picked", () => {
    const { onCreate, objects } = setup();

    expect(createButton()).toBeDisabled();

    pickAt(objects, 100, 60);

    expect(createButton()).toBeEnabled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("creates the character at the picked spot", async () => {
    const user = userEvent.setup();
    const { onCreate, objects } = setup();

    // 刻意不点画布中心：中心点在「读了落点」与「读了取景中心」两种实现下同值，
    // 是一条谁都能过的空绿。
    const spot = pickAt(objects, 96, 208);
    await user.click(createButton());

    const draft = created(onCreate);
    expect(draft.spot).not.toBeNull();
    expect(draft.spot?.[0]).toBeCloseTo(spot[0], 6);
    expect(draft.spot?.[1]).toBeCloseTo(spot[1], 6);
  });

  // 木偶预览是这个对话框存在的理由：三根微调滑杆改的是弯腰角度，不重画一帧的话
  // 用户拖完看到的还是上一副姿势，而滑杆的数值确实变了——像是模型卡住了。
  it("redraws the mannequin when the pose adjust sliders move", () => {
    const { onRenderPreview } = setup();

    expect(previewed(onRenderPreview).poseAdjust.pitch).toBe(0);

    fireEvent.change(screen.getByLabelText("previz.inspector.poseAdjust.pitch"), {
      target: { value: "12" },
    });

    expect(previewed(onRenderPreview).poseAdjust.pitch).toBe(12);
  });

  it("shows the already-placed characters on the top-down map", () => {
    const objects = [characterAt(3, -2, "#ff0000")];
    // jsdom 的 `getContext('2d')` 返回 null，选位图那一整段绘制在测试里一行都不会跑。
    // 塞个假的进来，「已有的人画没画上去」才钉得住。
    const arcs: { x: number; y: number; fillStyle: string }[] = [];
    const context = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn((x: number, y: number) => {
        arcs.push({ x, y, fillStyle: context.fillStyle });
      }),
      fill: vi.fn(),
      stroke: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );

    setup({ objects });

    const [px, py] = worldToCanvas(viewFor(objects), [3, -2]);
    // 传空数组进选位图也能画出一张网格，所以这里要认那个点本身：位置对得上、
    // 用的是这个人自己的辨识色。
    expect(arcs).toContainEqual({
      x: expect.closeTo(px, 6),
      y: expect.closeTo(py, 6),
      fillStyle: "#ff0000",
    });
  });

  it("names the new character 人物 N by default", async () => {
    const user = userEvent.setup();
    const objects = [characterAt(3, -2, "#ff0000")];
    const { onCreate } = setup({ objects });

    expect(screen.getByLabelText("previz.characterCreate.name")).toHaveValue("人物 2");

    pickAt(objects, 100, 60);
    await user.click(createButton());

    expect(created(onCreate).name).toBe("人物 2");
  });

  // 读屏用户看不见那个高亮环，读数是他唯一能确认「点到哪了」的东西；不标 live 的话
  // 焦点没动，屏幕阅读器一个字都不会念。
  it("announces the picked spot", () => {
    const { objects } = setup();

    const readout = screen.getByLabelText("previz.characterCreate.spotLabel");
    expect(readout).toHaveAttribute("aria-live", "polite");

    const spot = pickAt(objects, 96, 208);

    expect(readout).toHaveTextContent(`${spot[0].toFixed(2)} / ${spot[1].toFixed(2)}`);
  });

  it("closes without creating anything", async () => {
    const user = userEvent.setup();
    const { onCreate, onClose, objects } = setup();

    pickAt(objects, 100, 60);
    await user.click(screen.getByRole("button", { name: "previz.characterCreate.cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  // 身高框是受控的，逐键夹取会让「先删空再重输」输不进去：敲 `1` 立刻变成下界 120。
  // 夹取只在 `characterDraftOverrides` 那个出口做，对话框自己不碰。
  it("lets the height be typed through without clamping each key", () => {
    setup();

    const input = screen.getByLabelText("previz.inspector.heightCm");
    fireEvent.change(input, { target: { value: "1" } });

    expect(input).toHaveValue(1);
  });
});
