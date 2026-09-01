// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createPrevizObject, type PrevizObjectPatch } from "@/features/previz/domain/objects";
import type {
  PrevizObject,
  PrevizObjectKind,
  PrevizTransform,
} from "@/features/previz/domain/scene";
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
 * 回读方向（对象字段 → 输入框显示值）的夹具**不能**让同族字段取同一个值。工厂给的
 * 默认变换是 position / rotation 全零、scale 全一，于是「三个通道的 value 全读 rotation」
 * 这种串线一条断言都碰不到——position 与 rotation 本来就相等，而 scale 从 1 变成 0
 * 也没人看。下面九个分量两两不同（含正负与小数），三个通道之间、每个通道的三根轴
 * 之间，任意一处读串了都至少有一条断言变红。
 *
 * 每次调用返回新对象：数组是可变的，共用一份会让某个用例的 patch 泄到下一个用例。
 */
function distinctTransform(): PrevizTransform {
  return { position: [1, -2, 3], rotation: [10, 20, -30], scale: [0.5, 2, 1.5] };
}

/**
 * 同理，默认 poseAdjust 是 `{pitch: 0, turn: 0, lean: 0}`，三根滑杆全读 pitch 也照样绿。
 * 三个值两两不同、正负都有，且各自落在本轴的区间内（pitch -30..45 / turn -60..60 /
 * lean -35..35，都是 step=1 的整数格点）——超界的话滑杆自己会把值夹回去，夹具就白设了。
 * 三个值也刻意避开 `distinctTransform()` 的九个分量，免得跨族串读（滑杆读到位置分量）
 * 蒙混过关。
 */
function distinctPoseAdjust(): { pitch: number; turn: number; lean: number } {
  return { pitch: 5, turn: -12, lean: 7 };
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
    const onChange = renderInspector(
      createPrevizObject("prop", [], { transform: distinctTransform() }),
    );

    setValue(screen.getByLabelText("previz.inspector.position.y"), "7");

    expect(onChange).toHaveBeenLastCalledWith({
      transform: { position: [1, 7, 3], rotation: [10, 20, -30], scale: [0.5, 2, 1.5] },
    });
  });

  // 三个通道（位移 / 旋转 / 缩放）各三轴共用一个 patch 函数，串了线不会有任何编译期
  // 症状，只会让用户拖旋转时物体在挪位置。逐通道各锁一轴。
  it("routes the rotation axes to the rotation channel", () => {
    const onChange = renderInspector(
      createPrevizObject("prop", [], { transform: distinctTransform() }),
    );

    setValue(screen.getByLabelText("previz.inspector.rotation.z"), "5");

    expect(onChange).toHaveBeenLastCalledWith({
      transform: { position: [1, -2, 3], rotation: [10, 20, 5], scale: [0.5, 2, 1.5] },
    });
  });

  it("routes the scale axes to the scale channel", () => {
    const onChange = renderInspector(
      createPrevizObject("prop", [], { transform: distinctTransform() }),
    );

    setValue(screen.getByLabelText("previz.inspector.scale.x"), "4");

    expect(onChange).toHaveBeenLastCalledWith({
      transform: { position: [1, -2, 3], rotation: [10, 20, -30], scale: [4, 2, 1.5] },
    });
  });

  // 写入方向（改哪个框 → 发什么 patch）在上面三条里锁住了，但**显示**方向是另一件事：
  // 每个框的 `value` 各自从 `transform[channel][index]` 取数，三个通道九根轴任意一处
  // 读串了，写入照样正常、什么都不报错，只有读数是错的——「旋转框显示的是位置的值」
  // 这类故障接上真 store 之后极难查。九个分量两两不同，逐个钉住。
  it("shows every transform channel and axis on its own input", () => {
    renderInspector(createPrevizObject("prop", [], { transform: distinctTransform() }));

    expect(screen.getByLabelText("previz.inspector.position.x")).toHaveValue(1);
    expect(screen.getByLabelText("previz.inspector.position.y")).toHaveValue(-2);
    expect(screen.getByLabelText("previz.inspector.position.z")).toHaveValue(3);
    expect(screen.getByLabelText("previz.inspector.rotation.x")).toHaveValue(10);
    expect(screen.getByLabelText("previz.inspector.rotation.y")).toHaveValue(20);
    expect(screen.getByLabelText("previz.inspector.rotation.z")).toHaveValue(-30);
    expect(screen.getByLabelText("previz.inspector.scale.x")).toHaveValue(0.5);
    expect(screen.getByLabelText("previz.inspector.scale.y")).toHaveValue(2);
    expect(screen.getByLabelText("previz.inspector.scale.z")).toHaveValue(1.5);
  });

  // 编辑一根轴之后，其余八个读数必须原地不动。上一条锁的是初始渲染，这条锁的是
  // 「改完之后重新渲染时还是各读各的」——受控框每次 change 都会整块重算。
  it("keeps the other transform readouts put after one axis is edited", () => {
    renderInspector(createPrevizObject("prop", [], { transform: distinctTransform() }));

    setValue(screen.getByLabelText("previz.inspector.rotation.y"), "44");

    expect(screen.getByLabelText("previz.inspector.rotation.y")).toHaveValue(44);
    expect(screen.getByLabelText("previz.inspector.position.x")).toHaveValue(1);
    expect(screen.getByLabelText("previz.inspector.position.y")).toHaveValue(-2);
    expect(screen.getByLabelText("previz.inspector.position.z")).toHaveValue(3);
    expect(screen.getByLabelText("previz.inspector.rotation.x")).toHaveValue(10);
    expect(screen.getByLabelText("previz.inspector.rotation.z")).toHaveValue(-30);
    expect(screen.getByLabelText("previz.inspector.scale.x")).toHaveValue(0.5);
    expect(screen.getByLabelText("previz.inspector.scale.y")).toHaveValue(2);
    expect(screen.getByLabelText("previz.inspector.scale.z")).toHaveValue(1.5);
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
    const onChange = renderInspector(
      createPrevizObject("character", [], { poseAdjust: distinctPoseAdjust() }),
    );

    // range 输入用 fireEvent：userEvent 对滑杆的拖动模拟在 jsdom 里不产生 change。
    setValue(screen.getByLabelText("previz.inspector.poseAdjust.turn"), "15");

    // 另外两轴要带着**它们原本的值**过来。夹具全零的话，一份 `{pitch: 0, lean: 0, …}`
    // 的硬编码回调也能绿。
    expect(onChange).toHaveBeenLastCalledWith({
      poseAdjust: { pitch: 5, turn: 15, lean: 7 },
    });
  });

  it("edits the remaining pose-adjust axes on their own keys", () => {
    const onChange = renderInspector(
      createPrevizObject("character", [], { poseAdjust: distinctPoseAdjust() }),
    );

    setValue(screen.getByLabelText("previz.inspector.poseAdjust.pitch"), "20");
    expect(onChange).toHaveBeenLastCalledWith({ poseAdjust: { pitch: 20, turn: -12, lean: 7 } });

    setValue(screen.getByLabelText("previz.inspector.poseAdjust.lean"), "-10");
    expect(onChange).toHaveBeenLastCalledWith({ poseAdjust: { pitch: 20, turn: -12, lean: -10 } });
  });

  // 三根滑杆是同一段 map 出来的，`value` 写死成某一轴（比如三根都读 pitch）在默认夹具
  // 下毫无症状——三轴都是 0。这条盯的就是「每根滑杆读自己那一轴」。
  // range 输入的 `toHaveValue` 给的是字符串（jest-dom 只对 type="number" 转数字）。
  it("shows each pose-adjust axis on its own slider", () => {
    renderInspector(createPrevizObject("character", [], { poseAdjust: distinctPoseAdjust() }));

    expect(screen.getByLabelText("previz.inspector.poseAdjust.pitch")).toHaveValue("5");
    expect(screen.getByLabelText("previz.inspector.poseAdjust.turn")).toHaveValue("-12");
    expect(screen.getByLabelText("previz.inspector.poseAdjust.lean")).toHaveValue("7");
  });

  // 拖了一根之后其余两根不许跟着跳。
  it("keeps the other pose-adjust sliders put after one axis is dragged", () => {
    renderInspector(createPrevizObject("character", [], { poseAdjust: distinctPoseAdjust() }));

    setValue(screen.getByLabelText("previz.inspector.poseAdjust.turn"), "30");

    expect(screen.getByLabelText("previz.inspector.poseAdjust.turn")).toHaveValue("30");
    expect(screen.getByLabelText("previz.inspector.poseAdjust.pitch")).toHaveValue("5");
    expect(screen.getByLabelText("previz.inspector.poseAdjust.lean")).toHaveValue("7");
  });

  // 身高 / 体型 / 基础姿势三个框各读各的字段。三个值都取成非默认值：读到默认值上去
  // （`value={175}` 之类）在默认夹具下同样看不出来。
  it("shows the character's own height, body type and base pose", () => {
    renderInspector(
      createPrevizObject("character", [], {
        heightCm: 163,
        bodyType: "heavy",
        basePoseId: "sitting",
      }),
    );

    expect(screen.getByLabelText("previz.inspector.heightCm")).toHaveValue(163);
    expect(screen.getByLabelText("previz.inspector.bodyType")).toHaveValue("heavy");
    expect(screen.getByLabelText("previz.inspector.basePose")).toHaveValue("sitting");
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

  // 焦距、光圈、机身三个框各读各的字段。默认机位是 50 mm / f2.8 / ff——光圈框显示焦距
  // 之类的串读在**没有任何回读断言**时完全无症状，所以这里三个值全取非默认，逐个钉。
  it("shows the camera's own focal length, aperture and sensor", () => {
    renderInspector(
      createPrevizObject("camera", [], { focalMm: 85, aperture: 5.6, sensor: "s35" }),
    );

    expect(screen.getByLabelText("previz.inspector.focalMm")).toHaveValue(85);
    expect(screen.getByLabelText("previz.inspector.aperture")).toHaveValue(5.6);
    expect(screen.getByLabelText("previz.inspector.sensor")).toHaveValue("s35");
    // Super 35 的 85 mm 是 16.7°：读数要同时跟着焦距与机身走，把 aperture 当焦距喂进
    // 换算（5.6 mm 在 s35 上是 132.6°）也会在这里现形。
    expect(screen.getByTestId("previz-inspector-fov")).toHaveTextContent(/^16\.7°$/);
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

  // 灯光的三个框同理。强度默认是 1，而默认 scale 也是 [1, 1, 1]——滑杆读到 scale.x 上去
  // 在默认夹具下一模一样。取 3.5（滑杆区间 0..10、step 0.1 的合法格点）把它们分开。
  it("shows the light's own type, colour and intensity", () => {
    renderInspector(
      createPrevizObject("light", [], {
        lightType: "spot",
        color: "#3366cc",
        intensity: 3.5,
      }),
    );

    expect(screen.getByLabelText("previz.inspector.lightType")).toHaveValue("spot");
    expect(screen.getByLabelText("previz.inspector.color")).toHaveValue("#3366cc");
    expect(screen.getByLabelText("previz.inspector.intensity")).toHaveValue("3.5");
  });

  it("shows the prop asset url read-only", () => {
    renderInspector(
      createPrevizObject("prop", [], { name: "红椅子", assetUrl: "/static/chair.glb" }),
    );

    // 名字框也是回读方向的一员：它显示的必须是 name，不是 id、也不是资产路径。
    expect(screen.getByLabelText("previz.inspector.name")).toHaveValue("红椅子");
    const input = screen.getByLabelText("previz.inspector.assetUrl");
    expect(input).toHaveValue("/static/chair.glb");
    // 手打 URL 只会打错；换模型走工具栏的导入。
    expect(input).toHaveAttribute("readonly");
  });
});
