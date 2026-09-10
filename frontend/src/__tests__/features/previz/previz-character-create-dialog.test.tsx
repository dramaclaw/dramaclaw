// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPrevizObject,
  PREVIZ_CHARACTER_COLORS,
} from "@/features/previz/domain/objects";
import type { PrevizCharacterDraft } from "@/features/previz/domain/characterDraft";
import type { PrevizObject } from "@/features/previz/domain/scene";
import {
  canvasToWorld,
  sceneTopDownBounds,
  topDownView,
  worldToCanvas,
  type PrevizTopDownFootprint,
} from "@/features/previz/domain/topDownMap";
import { PREVIZ_TOP_DOWN_PICKER_SIZE } from "@/features/previz/ui/PrevizTopDownPicker";
import { PrevizCharacterCreateDialog } from "@/features/previz/ui/PrevizCharacterCreateDialog";

// 回显 key，与 previz-camera-create-dialog.test.tsx 同一个做法：断言里出现的是 key
// 本身，改一句中文文案不该让这个文件变红。带插值的 key 把参数一起回显：三根姿态轴的
// 数值框共用一个 key，只回显 key 的话它们重名，`getByRole` 一抓抓到三个。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
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
function viewFor(
  objects: readonly PrevizObject[],
  footprints: readonly PrevizTopDownFootprint[] = [],
) {
  return topDownView(
    sceneTopDownBounds(objects, footprints),
    PREVIZ_TOP_DOWN_PICKER_SIZE.width,
    PREVIZ_TOP_DOWN_PICKER_SIZE.height,
  );
}

/** 在选位图上点一下，返回这一下按 domain 映射应该得到的世界 XZ。 */
function pickAt(
  objects: readonly PrevizObject[],
  clientX: number,
  clientY: number,
  footprints: readonly PrevizTopDownFootprint[] = [],
): readonly [number, number] {
  stubPickerRect();
  fireEvent.click(screen.getByRole("button", { name: /previz\.characterCreate\.pickHint/ }), {
    // `detail: 1` 才走坐标那条路：0 是键盘 / 合成点击，选位图会回落到取景中心。
    detail: 1,
    clientX,
    clientY,
  });
  return canvasToWorld(viewFor(objects, footprints), [clientX, clientY]);
}

function createButton(): HTMLElement {
  return screen.getByRole("button", { name: "previz.characterCreate.create" });
}

/** 姿态某一轴的数值框。名字里的冒号来自文件顶上那个会回显插值参数的 `t` 桩。 */
function poseBox(axis: "pitch" | "turn" | "lean"): HTMLElement {
  return screen.getByRole("spinbutton", {
    name: `previz.characterCreate.poseValue:previz.inspector.poseAdjust.${axis}`,
  });
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

  /**
   * 一条把右栏每个可编辑字段都走到 `onCreate` 的用例。拆成六条更好看，但这一栏的失败
   * 模式是同一个：`onChange` 接错字段、或者接到一个空补丁上——控件在屏幕上照样能选能
   * 改，值也照样跟着变，只有最后交出去的那份草稿还是默认值。用户建完才发现体型没生效。
   *
   * 不是假想：把名称 / 辨识颜色 / 体型 / 基础姿势 / 高度策略五个 `onChange` 一起换成
   * `patch({})`，previz + i18n + stores 三路 87 文件 1612 条全绿——这一栏此前一条覆盖
   * 都没有。`satisfies Record<T, true>` 只挡「下拉少一档」，挡不住「下拉接错线」。
   *
   * 每个值都刻意偏离工厂默认（average / standing / follow / 175 / 0），且两两不同：
   * 取成默认值的话「读了控件」与「压根没读」两种实现都绿。
   */
  it("carries every edited field into the created draft", async () => {
    const user = userEvent.setup();
    const { onCreate, objects } = setup();

    // 先选位：属性那一栏在选位之前是一块占位提示，字段还没挂上去。
    pickAt(objects, 96, 208);

    fireEvent.change(screen.getByLabelText("previz.characterCreate.name"), {
      target: { value: "张三" },
    });
    fireEvent.change(screen.getByLabelText("previz.characterCreate.customColor"), {
      target: { value: "#0a1b2c" },
    });
    await user.selectOptions(screen.getByLabelText("previz.inspector.bodyType"), "heavy");
    await user.selectOptions(screen.getByLabelText("previz.inspector.basePose"), "crouching");
    await user.selectOptions(screen.getByLabelText("previz.inspector.heightPolicy"), "plane");
    fireEvent.change(screen.getByLabelText("previz.inspector.heightCm"), {
      target: { value: "191" },
    });
    fireEvent.change(screen.getByLabelText("previz.inspector.poseAdjust.turn"), {
      target: { value: "-21" },
    });

    await user.click(createButton());

    expect(created(onCreate)).toMatchObject({
      name: "张三",
      color: "#0a1b2c",
      bodyType: "heavy",
      basePoseId: "crouching",
      heightPolicy: "plane",
      heightCm: 191,
      // 三轴整份带过去：只改一轴时另外两轴不许被抹掉。
      poseAdjust: { pitch: 0, turn: -21, lean: 0 },
    });
  });

  // 木偶预览是这个对话框存在的理由：三根微调滑杆改的是弯腰角度，不重画一帧的话
  // 用户拖完看到的还是上一副姿势，而滑杆的数值确实变了——像是模型卡住了。
  it("redraws the mannequin when the pose adjust sliders move", () => {
    const { onRenderPreview, objects } = setup();

    // 木偶那块画布也是选位之后才挂上去的，在那之前没有东西可画。
    pickAt(objects, 96, 208);
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

  it("hands the footprints straight through to the picker", async () => {
    const user = userEvent.setup();
    // 一件原点在 (0, 0)、向 +X 铺开 10 m 的布景。轮廓传不下去的话取景框就是默认那块
    // ±6 m 的地，同一下点击落在完全不同的世界坐标上——差的正好是这半间布景。
    const objects: PrevizObject[] = [{ ...createPrevizObject("prop", []), id: "set" }];
    const footprints = [{ id: "set", minX: 0, maxX: 10, minZ: -1, maxZ: 1 }];
    const { onCreate } = setup({ objects, footprints });

    const spot = pickAt(objects, 100, 60, footprints);
    await user.click(createButton());

    expect(created(onCreate).spot).not.toBeNull();
    expect(created(onCreate).spot?.[0]).toBeCloseTo(spot[0], 6);
    expect(created(onCreate).spot?.[1]).toBeCloseTo(spot[1], 6);
    // 与「没接上」那条实现区分开：不传轮廓时同一下点击落在别处。
    const [plainX] = canvasToWorld(viewFor(objects), [100, 60]);
    expect(spot[0]).not.toBeCloseTo(plainX, 3);
  });

  it("names the new character 人物 N by default", async () => {
    const user = userEvent.setup();
    const objects = [characterAt(3, -2, "#ff0000")];
    const { onCreate } = setup({ objects });

    pickAt(objects, 100, 60);
    expect(screen.getByLabelText("previz.characterCreate.name")).toHaveValue("人物 2");

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
    const { objects } = setup();

    pickAt(objects, 96, 208);
    const input = screen.getByLabelText("previz.inspector.heightCm");
    fireEvent.change(input, { target: { value: "1" } });

    expect(input).toHaveValue(1);
  });
});

/**
 * 辨识色改成一排色点。上游那一排是这个对话框里唯一「一眼扫过去就选完」的控件——
 * 用系统取色器选一个跟场上别人撞色的颜色，要点开面板、拖色环、再回来对一眼。
 */
describe("PrevizCharacterCreateDialog 的辨识色", () => {
  it("puts the eight presets on screen as one radio group", () => {
    const { objects } = setup();
    pickAt(objects, 96, 208);

    const swatches = screen.getAllByRole("radio");
    expect(swatches).toHaveLength(PREVIZ_CHARACTER_COLORS.length);
    // 有且只有一个选中：默认色也得是这排里的一个，否则用户开局看到八个都没选。
    expect(swatches.filter((swatch) => swatch.getAttribute("aria-checked") === "true"))
      .toHaveLength(1);
  });

  it("carries the picked swatch into the created draft", async () => {
    const user = userEvent.setup();
    const { onCreate, objects } = setup();
    pickAt(objects, 96, 208);

    // 第四个：工厂给空场景发的是第一个，取默认色的话「点了色点」与「压根没接线」同值。
    await user.click(screen.getAllByRole("radio")[3]!);
    await user.click(createButton());

    expect(created(onCreate).color).toBe(PREVIZ_CHARACTER_COLORS[3]);
  });

  it("still lets a colour outside the eight in through the custom picker", async () => {
    const user = userEvent.setup();
    const { onCreate, objects } = setup();
    pickAt(objects, 96, 208);

    // 八个是快捷方式，不是白名单：`hexColor` 收任何合法十六进制色，第九个人也得有得挑。
    fireEvent.change(screen.getByLabelText("previz.characterCreate.customColor"), {
      target: { value: "#123456" },
    });
    await user.click(createButton());

    expect(created(onCreate).color).toBe("#123456");
  });
});

/**
 * 三根微调滑杆各配一个数值框。滑杆调得动但报不出数：用户想要「正好 15 度」时只能
 * 拖着试，而这三个数最后是要落到人物身上的。
 */
describe("PrevizCharacterCreateDialog 的姿态数值框", () => {
  it("moves the number box when the slider moves", () => {
    const { objects } = setup();
    pickAt(objects, 96, 208);

    fireEvent.change(screen.getByLabelText("previz.inspector.poseAdjust.pitch"), {
      target: { value: "12" },
    });

    expect(poseBox("pitch")).toHaveValue(12);
  });

  it("moves the slider when the number box is typed into", async () => {
    const user = userEvent.setup();
    const { onCreate, objects } = setup();
    pickAt(objects, 96, 208);

    fireEvent.change(poseBox("pitch"), { target: { value: "-8" } });
    await user.click(createButton());

    expect(screen.getByLabelText("previz.inspector.poseAdjust.pitch")).toHaveValue("-8");
    // 只改一轴，另外两轴不许被抹掉——`poseAdjust` 是整份替换的。
    expect(created(onCreate).poseAdjust).toEqual({ pitch: -8, turn: 0, lean: 0 });
  });

  it("does not clamp the number box on every key", () => {
    // 逐键夹的话「-8」的那个负号会当场变成下界，第二个字符再也接不上去。
    const { objects } = setup();
    pickAt(objects, 96, 208);

    const box = poseBox("turn");
    fireEvent.change(box, { target: { value: "" } });

    expect(box).toHaveValue(null);
  });
});

/**
 * 没选位之前，中右两栏是占位提示。上游这么排是有道理的：人物的身高、姿态、朝向都
 * 只有落在场里的某一处才谈得上，先摆一整栏能改却改不出效果的字段，用户会以为自己
 * 已经建好了一个人。
 */
describe("PrevizCharacterCreateDialog 未选位时", () => {
  it("shows placeholders instead of the preview and the fields", () => {
    setup();

    expect(screen.getByText("previz.characterCreate.awaitPreview")).toBeInTheDocument();
    expect(screen.getByText("previz.characterCreate.awaitFields")).toBeInTheDocument();
    expect(screen.queryByLabelText("previz.characterCreate.name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("character-create-preview")).not.toBeInTheDocument();
  });

  it("swaps in the preview and the fields once a spot is picked", () => {
    const { objects } = setup();

    pickAt(objects, 96, 208);

    expect(screen.queryByText("previz.characterCreate.awaitPreview")).not.toBeInTheDocument();
    expect(screen.queryByText("previz.characterCreate.awaitFields")).not.toBeInTheDocument();
    expect(screen.getByLabelText("previz.characterCreate.name")).toBeInTheDocument();
    expect(screen.getByTestId("character-create-preview")).toBeInTheDocument();
  });
});

/** 移动辅助那一节。两个开关只在播放时管用，静止摆位不受影响，所以默认都不勾。 */
describe("PrevizCharacterCreateDialog 的移动辅助", () => {
  it("starts both switches off and carries them into the draft", async () => {
    const user = userEvent.setup();
    const { onCreate, objects } = setup();
    pickAt(objects, 96, 208);

    const avoid = screen.getByRole("checkbox", { name: "previz.inspector.avoidCollision" });
    const stay = screen.getByRole("checkbox", { name: "previz.inspector.stayInBounds" });
    expect(avoid).not.toBeChecked();
    expect(stay).not.toBeChecked();

    await user.click(avoid);
    await user.click(stay);
    await user.click(createButton());

    expect(created(onCreate)).toMatchObject({ avoidCollision: true, stayInBounds: true });
  });

  it("says on screen that the two switches only bite during playback", () => {
    const { objects } = setup();
    pickAt(objects, 96, 208);

    // 不写这句的话，用户会以为勾上就能把人从墙里推出来——而摆位时它一动不动。
    expect(screen.getByText("previz.inspector.moveAssistNote")).toBeInTheDocument();
  });
});
