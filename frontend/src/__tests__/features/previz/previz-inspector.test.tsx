// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createPrevizObject, type PrevizObjectPatch } from "@/features/previz/domain/objects";
import type { PrevizObject, PrevizObjectKind } from "@/features/previz/domain/scene";
import { PrevizInspector } from "@/features/previz/ui/PrevizInspector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/**
 * 面板的输入框全是受控的，所以测试必须把补丁真的应用回去：父级不更新 state 时，React
 * 每次 change 后都会把 DOM 的值还原成 prop，键入的字符会一个个丢掉（清空「物件 1」再
 * 打「椅子」，回调收到的是「物件 1子」）。这个壳子就是 Task 16 编辑器那一层的最小替身。
 */
function Harness({
  initial,
  spy,
}: {
  initial: PrevizObject | null;
  spy: (patch: PrevizObjectPatch) => void;
}) {
  const [object, setObject] = useState(initial);
  return (
    <PrevizInspector
      object={object}
      onChange={(patch) => {
        spy(patch);
        setObject((prev) => (prev ? ({ ...prev, ...patch } as PrevizObject) : prev));
      }}
    />
  );
}

function renderInspector(initial: PrevizObject | null) {
  const onChange = vi.fn();
  render(<Harness initial={initial} spy={onChange} />);
  return onChange;
}

/** 数字框与滑杆用 fireEvent 整值写入：受控框逐键输入会和区间夹取纠缠在一起，
 *  而这些用例要锁的是「一个完整的值进来会得到什么」。 */
function setValue(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}

/**
 * 期望值一律写字面量，不从被测模块（或它 import 的 domain 常量）取——跟着实现一起
 * 变的断言等于没有断言。区间、默认值、换算结果都在下面逐个写死。
 */
describe("PrevizInspector", () => {
  it("prompts to pick something when nothing is selected", () => {
    renderInspector(null);
    expect(screen.getByText("previz.inspector.empty")).toBeInTheDocument();
  });

  it("edits the name", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("prop", []));

    const input = screen.getByLabelText("previz.inspector.name");
    await user.clear(input);
    await user.type(input, "椅子");

    expect(onChange).toHaveBeenLastCalledWith({ name: "椅子" });
  });

  it("edits one transform axis without touching the others", () => {
    const onChange = renderInspector(createPrevizObject("prop", []));

    setValue(screen.getByLabelText("previz.inspector.position.y"), "2");

    expect(onChange).toHaveBeenLastCalledWith({
      transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
  });

  // 三个通道（位移 / 旋转 / 缩放）各三轴共用一个 patch 函数，串了线不会有任何编译期
  // 症状，只会让用户拖旋转时物体在挪位置。逐通道各锁一轴。
  it("routes the rotation axes to the rotation channel", () => {
    const onChange = renderInspector(createPrevizObject("prop", []));

    setValue(screen.getByLabelText("previz.inspector.rotation.z"), "5");

    expect(onChange).toHaveBeenLastCalledWith({
      transform: { position: [0, 0, 0], rotation: [0, 0, 5], scale: [1, 1, 1] },
    });
  });

  it("routes the scale axes to the scale channel", () => {
    const onChange = renderInspector(createPrevizObject("prop", []));

    setValue(screen.getByLabelText("previz.inspector.scale.x"), "2");

    expect(onChange).toHaveBeenLastCalledWith({
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] },
    });
  });

  // 输入框里删到空是编辑中间态，不是「把 y 设成 NaN」。放行 NaN 会让整个投影矩阵中毒。
  it("ignores a non-numeric transform entry", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("prop", []));

    await user.clear(screen.getByLabelText("previz.inspector.position.x"));

    expect(onChange).not.toHaveBeenCalled();
  });

  // 溢出成 Infinity 的输入不能进变换矩阵——整条投影链会算出 NaN，画面全黑，而病因离
  // 故障点很远。实测 jsdom（以及 HTML 的 value sanitization）会把 `1e999` 直接清成空串，
  // 所以在这个环境里拦住它的是空串那条分支；`Number.isFinite` 那条是留给「哪天有人把某个
  // 字段改成 type=\"text\"」的兜底，走不到 DOM 这一层来验。
  it("ignores an overflowing transform entry", () => {
    const onChange = renderInspector(createPrevizObject("prop", []));

    setValue(screen.getByLabelText("previz.inspector.position.z"), "1e999");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows only the character fields for a character", () => {
    renderInspector(createPrevizObject("character", []));

    expect(screen.getByLabelText("previz.inspector.heightCm")).toBeInTheDocument();
    expect(screen.getByLabelText("previz.inspector.bodyType")).toBeInTheDocument();
    expect(screen.getByLabelText("previz.inspector.basePose")).toBeInTheDocument();
    expect(screen.getByLabelText("previz.inspector.poseAdjust.pitch")).toBeInTheDocument();
    expect(screen.getByText("previz.inspector.poseAdjust.label")).toBeInTheDocument();
    expect(screen.queryByLabelText("previz.inspector.focalMm")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.lightType")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.assetUrl")).toBeNull();
  });

  it("shows only the camera fields for a camera", () => {
    renderInspector(createPrevizObject("camera", []));

    expect(screen.getByLabelText("previz.inspector.focalMm")).toBeInTheDocument();
    expect(screen.getByLabelText("previz.inspector.aperture")).toBeInTheDocument();
    expect(screen.getByLabelText("previz.inspector.sensor")).toBeInTheDocument();
    expect(screen.queryByLabelText("previz.inspector.heightCm")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.lightType")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.assetUrl")).toBeNull();
  });

  it("shows only the light fields for a light", () => {
    renderInspector(createPrevizObject("light", []));

    expect(screen.getByLabelText("previz.inspector.lightType")).toBeInTheDocument();
    expect(screen.getByLabelText("previz.inspector.color")).toBeInTheDocument();
    expect(screen.getByLabelText("previz.inspector.intensity")).toBeInTheDocument();
    expect(screen.queryByLabelText("previz.inspector.heightCm")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.focalMm")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.assetUrl")).toBeNull();
  });

  it("shows only the prop fields for a prop", () => {
    renderInspector(createPrevizObject("prop", []));

    expect(screen.getByLabelText("previz.inspector.assetUrl")).toBeInTheDocument();
    expect(screen.queryByLabelText("previz.inspector.heightCm")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.focalMm")).toBeNull();
    expect(screen.queryByLabelText("previz.inspector.lightType")).toBeNull();
  });

  it("keeps the name and transform fields on every kind", () => {
    const kinds: readonly PrevizObjectKind[] = ["character", "camera", "light", "prop"];
    for (const kind of kinds) {
      const { unmount } = render(
        <PrevizInspector object={createPrevizObject(kind, [])} onChange={vi.fn()} />,
      );
      expect(screen.getByLabelText("previz.inspector.name")).toBeInTheDocument();
      for (const channel of ["position", "rotation", "scale"] as const) {
        expect(screen.getByText(`previz.inspector.${channel}.label`)).toBeInTheDocument();
      }
      const positionX = screen.getByLabelText("previz.inspector.position.x");
      expect(positionX).toHaveAttribute("type", "number");
      // 位移与缩放按 0.1 步进，旋转按整度：拖着微调箭头时这个差别很显眼。
      expect(positionX).toHaveAttribute("step", "0.1");
      expect(screen.getByLabelText("previz.inspector.rotation.y")).toHaveAttribute("step", "1");
      expect(screen.getByLabelText("previz.inspector.scale.z")).toHaveAttribute("step", "0.1");
      unmount();
    }
  });

  it("shows the character defaults and edits the pose", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("character", []));

    expect(screen.getByLabelText("previz.inspector.heightCm")).toHaveValue(175);
    await user.selectOptions(screen.getByLabelText("previz.inspector.basePose"), "sitting");

    expect(onChange).toHaveBeenLastCalledWith({ basePoseId: "sitting" });
  });

  it("edits the body type", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("character", []));

    await user.selectOptions(screen.getByLabelText("previz.inspector.bodyType"), "heavy");

    expect(onChange).toHaveBeenLastCalledWith({ bodyType: "heavy" });
  });

  it("clamps the height into the supported range", () => {
    const onChange = renderInspector(createPrevizObject("character", []));

    const input = screen.getByLabelText("previz.inspector.heightCm");
    expect(input).toHaveAttribute("min", "120");
    expect(input).toHaveAttribute("max", "220");

    setValue(input, "999");
    expect(onChange).toHaveBeenLastCalledWith({ heightCm: 220 });

    setValue(input, "5");
    expect(onChange).toHaveBeenLastCalledWith({ heightCm: 120 });

    setValue(input, "168");
    expect(onChange).toHaveBeenLastCalledWith({ heightCm: 168 });
  });

  // 清空身高框和清空位置框是同一种编辑中间态：Number("") 是 0，不拦就会当场把人物
  // 压到最矮的 120，用户连第二个数字都还没敲。
  it("ignores an emptied height entry", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("character", []));

    await user.clear(screen.getByLabelText("previz.inspector.heightCm"));

    expect(onChange).not.toHaveBeenCalled();
  });

  // 三根微调滑杆共用一个 poseAdjust 对象，回调里漏展开就会把另外两轴清成 undefined。
  it("edits one pose-adjust axis without dropping the others", () => {
    const onChange = renderInspector(createPrevizObject("character", []));

    // range 输入用 fireEvent：userEvent 对滑杆的拖动模拟在 jsdom 里不产生 change。
    setValue(screen.getByLabelText("previz.inspector.poseAdjust.turn"), "15");

    expect(onChange).toHaveBeenLastCalledWith({
      poseAdjust: { pitch: 0, turn: 15, lean: 0 },
    });
  });

  it("edits the remaining pose-adjust axes on their own keys", () => {
    const onChange = renderInspector(createPrevizObject("character", []));

    setValue(screen.getByLabelText("previz.inspector.poseAdjust.pitch"), "20");
    expect(onChange).toHaveBeenLastCalledWith({ poseAdjust: { pitch: 20, turn: 0, lean: 0 } });

    setValue(screen.getByLabelText("previz.inspector.poseAdjust.lean"), "-10");
    expect(onChange).toHaveBeenLastCalledWith({ poseAdjust: { pitch: 20, turn: 0, lean: -10 } });
  });

  // 三轴的区间各不相同（人向前屈得比向后仰得多），一根滑杆一根滑杆地锁住，
  // 免得有人图省事把三根都写成同一对 ±30。
  it("gives each pose-adjust slider its own range", () => {
    renderInspector(createPrevizObject("character", []));

    const bounds = [
      { axis: "pitch", min: "-30", max: "45" },
      { axis: "turn", min: "-60", max: "60" },
      { axis: "lean", min: "-35", max: "35" },
    ] as const;
    for (const { axis, min, max } of bounds) {
      const slider = screen.getByLabelText(`previz.inspector.poseAdjust.${axis}`);
      expect(slider).toHaveAttribute("type", "range");
      expect(slider).toHaveAttribute("min", min);
      expect(slider).toHaveAttribute("max", max);
    }
  });

  it("shows camera fields and reports the derived angle of view", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("camera", []));

    // 全画幅 50 mm 的水平视场角是 39.6°，直接显示出来省得用户自己心算。
    expect(screen.getByTestId("previz-inspector-fov")).toHaveTextContent(/^39\.6°$/);

    await user.selectOptions(screen.getByLabelText("previz.inspector.sensor"), "s35");
    expect(onChange).toHaveBeenLastCalledWith({ sensor: "s35" });
    // 换机身要真的换掉换算里的传感器宽度：Super 35 的 50 mm 是 28.0°，不是 39.6°。
    expect(screen.getByTestId("previz-inspector-fov")).toHaveTextContent(/^28\.0°$/);
  });

  it("recomputes the angle of view when the focal length changes", () => {
    renderInspector(createPrevizObject("camera", []));

    // 全画幅 24 mm 是 73.7°。
    setValue(screen.getByLabelText("previz.inspector.focalMm"), "24");
    expect(screen.getByTestId("previz-inspector-fov")).toHaveTextContent(/^73\.7°$/);
  });

  it("clamps focal length into the supported range", () => {
    const onChange = renderInspector(createPrevizObject("camera", []));

    const input = screen.getByLabelText("previz.inspector.focalMm");
    expect(input).toHaveAttribute("min", "12");
    expect(input).toHaveAttribute("max", "200");

    setValue(input, "900");
    expect(onChange).toHaveBeenLastCalledWith({ focalMm: 200 });

    setValue(input, "5");
    expect(onChange).toHaveBeenLastCalledWith({ focalMm: 12 });

    setValue(input, "85");
    expect(onChange).toHaveBeenLastCalledWith({ focalMm: 85 });
  });

  it("clamps the aperture into the supported range", () => {
    const onChange = renderInspector(createPrevizObject("camera", []));

    const input = screen.getByLabelText("previz.inspector.aperture");
    expect(input).toHaveAttribute("min", "1.2");
    expect(input).toHaveAttribute("max", "22");

    setValue(input, "99");
    expect(onChange).toHaveBeenLastCalledWith({ aperture: 22 });

    setValue(input, "0");
    expect(onChange).toHaveBeenLastCalledWith({ aperture: 1.2 });

    setValue(input, "4");
    expect(onChange).toHaveBeenLastCalledWith({ aperture: 4 });
  });

  // 清空焦距框同样是中间态：夹取对非有限值会回落到默认 50 mm，逐键放行的话
  // 用户一删就跳回 50，再也打不出 120。
  it("ignores an emptied camera entry", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("camera", []));

    await user.clear(screen.getByLabelText("previz.inspector.focalMm"));
    await user.clear(screen.getByLabelText("previz.inspector.aperture"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows light fields", async () => {
    const user = userEvent.setup();
    const onChange = renderInspector(createPrevizObject("light", []));

    await user.selectOptions(screen.getByLabelText("previz.inspector.lightType"), "spot");

    expect(onChange).toHaveBeenLastCalledWith({ lightType: "spot" });
  });

  it("edits the light colour", () => {
    const onChange = renderInspector(createPrevizObject("light", []));

    const input = screen.getByLabelText("previz.inspector.color");
    expect(input).toHaveAttribute("type", "color");
    setValue(input, "#ff8800");

    expect(onChange).toHaveBeenLastCalledWith({ color: "#ff8800" });
  });

  it("edits the light intensity over the full slider travel", () => {
    const onChange = renderInspector(createPrevizObject("light", []));

    const slider = screen.getByLabelText("previz.inspector.intensity");
    expect(slider).toHaveAttribute("type", "range");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "10");

    setValue(slider, "7.5");

    expect(onChange).toHaveBeenLastCalledWith({ intensity: 7.5 });
  });

  it("shows the prop asset url read-only", () => {
    renderInspector(createPrevizObject("prop", [], { assetUrl: "/static/chair.glb" }));

    const input = screen.getByLabelText("previz.inspector.assetUrl");
    expect(input).toHaveValue("/static/chair.glb");
    // 手打 URL 只会打错；换模型走工具栏的导入。
    expect(input).toHaveAttribute("readonly");
  });
});
