// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PrevizCameraDraft } from "@/features/previz/domain/cameraDraft";
import {
  PREVIZ_PREVIEW_DRAG_DEG_PER_PX,
  PrevizCameraCreateDialog,
} from "@/features/previz/ui/PrevizCameraCreateDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

type DialogProps = ComponentProps<typeof PrevizCameraCreateDialog>;

/** 眼位在 +X+Y+Z、看向原点上方一点：偏航、俯仰都不是 0，好让读数断言有区分度。 */
const VIEW_POSE = { position: [6, 4, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number] };

function setup(overrides: Partial<DialogProps> = {}) {
  const onCreate = vi.fn();
  const onClose = vi.fn();
  const onRenderPreview = vi.fn();
  const props: DialogProps = {
    open: true,
    viewPose: VIEW_POSE,
    outputAspect: "16:9",
    onRenderPreview,
    onCreate,
    onClose,
    ...overrides,
  };
  const view = render(<PrevizCameraCreateDialog {...props} />);
  return { ...view, onCreate, onClose, onRenderPreview };
}

/** 最后一次 onCreate 收到的草稿。 */
function created(onCreate: ReturnType<typeof vi.fn>): PrevizCameraDraft {
  return onCreate.mock.calls[onCreate.mock.calls.length - 1]?.[0] as PrevizCameraDraft;
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "previz.cameraCreate.submit" }));
}

describe("PrevizCameraCreateDialog", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("seeds the draft from the director view", async () => {
    const user = userEvent.setup();
    const { onCreate } = setup();

    // 「当前导演视角」读的是眼位本身，不是新机位的落位——新机位沿视线往前挪过。
    expect(screen.getByLabelText("previz.cameraCreate.viewReadoutLabel")).toHaveTextContent(
      "6.0 / 4.0 / 8.0",
    );

    await submit(user);
    const draft = created(onCreate);
    expect(draft.position[0]).toBeCloseTo(4.8, 6);
    // 角度种进来时就圆到 0.1°，好让受控输入框里显示的和存着的是同一个数。
    expect(draft.yawDeg).toBeCloseTo(36.9, 6);
    expect(draft.pitchDeg).toBe(-16.7);
    expect(draft.rollDeg).toBe(0);
    expect(draft.focalMm).toBe(50);
    expect(draft.sensor).toBe("ff");
  });

  it("re-seeds the draft each time it opens", async () => {
    const user = userEvent.setup();
    const { rerender, onCreate } = setup();

    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.focalUp" }));
    rerender(
      <PrevizCameraCreateDialog
        open={false}
        viewPose={VIEW_POSE}
        outputAspect="16:9"
        onRenderPreview={vi.fn()}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );
    rerender(
      <PrevizCameraCreateDialog
        open
        viewPose={{ position: [0, 2, 5], target: [0, 2, 0] }}
        outputAspect="16:9"
        onRenderPreview={vi.fn()}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    // 关掉再开是「重新建一台」，不是「接着上次编辑」——上次改到 85mm 不该留下来。
    expect(screen.getByTestId("camera-create-focal")).toHaveTextContent("50mm");
    await submit(user);
    expect(created(onCreate).yawDeg).toBeCloseTo(0, 6);
  });

  it("steps the focal length through the stop table and clamps at both ends", async () => {
    const user = userEvent.setup();
    setup();
    const up = screen.getByRole("button", { name: "previz.cameraCreate.focalUp" });
    const down = screen.getByRole("button", { name: "previz.cameraCreate.focalDown" });
    const value = screen.getByTestId("camera-create-focal");

    expect(value).toHaveTextContent("50mm");
    // 焦距下面那行读数：口语分类 + 镜头自身的纵向视场角，与属性面板同一个数。
    expect(screen.getByTestId("camera-create-focal-note")).toHaveTextContent(
      "previz.cameraCreate.focalClasses.standard · 27.0°",
    );

    await user.click(up);
    expect(value).toHaveTextContent("85mm");
    expect(screen.getByTestId("camera-create-focal-note")).toHaveTextContent(
      "previz.cameraCreate.focalClasses.teleShort · 16.1°",
    );

    for (let index = 0; index < 5; index += 1) await user.click(up);
    expect(value).toHaveTextContent("200mm");

    for (let index = 0; index < 20; index += 1) await user.click(down);
    expect(value).toHaveTextContent("14mm");
    expect(screen.getByTestId("camera-create-focal-note")).toHaveTextContent(
      "previz.cameraCreate.focalClasses.ultrawide · 81.2°",
    );
  });

  it("steps the aperture and labels its depth of field", async () => {
    const user = userEvent.setup();
    const { onCreate } = setup();
    const value = screen.getByTestId("camera-create-aperture");

    expect(value).toHaveTextContent("f/2.8");
    expect(screen.getByTestId("camera-create-aperture-note")).toHaveTextContent(
      "previz.cameraCreate.depthOfField.standard",
    );

    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.apertureDown" }));
    expect(value).toHaveTextContent("f/2");
    expect(screen.getByTestId("camera-create-aperture-note")).toHaveTextContent(
      "previz.cameraCreate.depthOfField.shallow",
    );

    await submit(user);
    expect(created(onCreate).aperture).toBe(2);
  });

  it("cycles the label-only steppers instead of clamping them", async () => {
    const user = userEvent.setup();
    const { onCreate } = setup();
    const body = screen.getByTestId("camera-create-body");

    expect(body).toHaveTextContent("previz.cameraCreate.bodies.cine");
    // 机身与镜头系列只是标签，没有「到头了」的物理含义，所以循环而不是夹住。
    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.bodyPrev" }));
    expect(body).toHaveTextContent("previz.cameraCreate.bodies.handheld");

    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.lensNext" }));
    expect(screen.getByTestId("camera-create-lens")).toHaveTextContent(
      "previz.cameraCreate.lenses.zoom",
    );

    await submit(user);
    expect(created(onCreate)).toMatchObject({ cameraBody: "handheld", lensSeries: "zoom" });
  });

  it("recomputes the angle of view when the sensor changes", async () => {
    const user = userEvent.setup();
    const { onCreate } = setup();

    await user.selectOptions(screen.getByLabelText("previz.cameraCreate.sensor"), "s35");

    // Super 35 的成像面更小，同一支 50mm 的视场角从 27.0° 收到 21.1°。
    expect(screen.getByTestId("camera-create-focal-note")).toHaveTextContent("· 21.1°");
    await submit(user);
    expect(created(onCreate).sensor).toBe("s35");
  });

  it("keeps the yaw slider and its number field on the same value", async () => {
    const user = userEvent.setup();
    const { onCreate } = setup();
    const slider = screen.getByLabelText("previz.cameraCreate.yawSlider");
    const field = screen.getByLabelText("previz.cameraCreate.yawInput");

    fireEvent.change(slider, { target: { value: "120" } });
    expect(field).toHaveValue(120);

    fireEvent.change(field, { target: { value: "200" } });
    expect(slider).toHaveValue("200");

    await submit(user);
    expect(created(onCreate).yawDeg).toBe(200);
  });

  it("wraps yaw and clamps pitch and roll", async () => {
    const user = userEvent.setup();
    const { onCreate } = setup();

    // 水平角是循环量：敲进 -30 存下来的是 330，不是被夹在 0。
    fireEvent.change(screen.getByLabelText("previz.cameraCreate.yawInput"), {
      target: { value: "-30" },
    });
    fireEvent.change(screen.getByLabelText("previz.cameraCreate.pitchInput"), {
      target: { value: "200" },
    });
    fireEvent.change(screen.getByLabelText("previz.cameraCreate.rollInput"), {
      target: { value: "-900" },
    });

    await submit(user);
    expect(created(onCreate)).toMatchObject({ yawDeg: 330, pitchDeg: 90, rollDeg: -180 });
  });

  it("aims the camera by dragging the preview", async () => {
    const user = userEvent.setup();
    const { onCreate } = setup();
    const canvas = screen.getByTestId("camera-create-preview");

    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 140, clientY: 80, pointerId: 1 });
    // 松手之后再动鼠标不该继续转——拖拽结束要把 window 上的监听摘掉。
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300, pointerId: 1 });

    await submit(user);
    const draft = created(onCreate);
    // 抓着画面拖：往右拖等于把世界往右推，机位向左转，偏航变大（+Y 逆时针）。
    expect(draft.yawDeg).toBeCloseTo(36.9 + 40 * PREVIZ_PREVIEW_DRAG_DEG_PER_PX, 6);
    // 往上拖等于把世界往上推，镜头向下压。
    expect(draft.pitchDeg).toBeCloseTo(-16.7 - 20 * PREVIZ_PREVIEW_DRAG_DEG_PER_PX, 6);
  });

  it("redraws the preview whenever the draft changes", async () => {
    const user = userEvent.setup();
    const { onRenderPreview } = setup();

    expect(onRenderPreview).toHaveBeenCalled();
    const first = onRenderPreview.mock.calls.length;
    expect(onRenderPreview.mock.calls[0]?.[0]).toBe(screen.getByTestId("camera-create-preview"));

    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.focalUp" }));

    expect(onRenderPreview.mock.calls.length).toBeGreaterThan(first);
    const last = onRenderPreview.mock.calls[onRenderPreview.mock.calls.length - 1];
    expect(last?.[1]).toMatchObject({ focalMm: 85 });
  });

  it("closes without creating anything", async () => {
    const user = userEvent.setup();
    const { onClose, onCreate } = setup();

    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("keeps the angle number field off the full row width", () => {
    // 这不是在测审美，是在测一条踩过的坑：类名字符串的先后不决定胜负，Tailwind
    // 的样式表里 w-full 排在 w-16 之后，`${FIELD} w-16` 实际生效的是 w-full。
    // 数字框吃满整行又 shrink-0，会把整列撑得比弹窗还宽，控件溢出到面板外面。
    setup();

    const field = screen.getByLabelText("previz.cameraCreate.yawInput");
    expect(field.className).toMatch(/\bw-\d+\b/);
    expect(field.className).not.toContain("w-full");
  });

});
