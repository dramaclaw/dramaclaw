// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  characterDraftOverrides,
  clampCharacterDraft,
  createCharacterDraft,
  isPlacedCharacterDraft,
  type PrevizCharacterDraft,
  type PrevizPlacedCharacterDraft,
} from "@/features/previz/domain/characterDraft";
import {
  PREVIZ_MAX_HEIGHT_CM,
  PREVIZ_MIN_HEIGHT_CM,
  PREVIZ_DEFAULT_HEIGHT_CM,
  createPrevizObject,
} from "@/features/previz/domain/objects";
import type { PrevizObject } from "@/features/previz/domain/scene";

/** 点过位的草稿。除了 spot 之外全走默认值，各条用例只改自己关心的那个字段。 */
function placed(patch: Partial<PrevizCharacterDraft> = {}): PrevizPlacedCharacterDraft {
  const { spot, ...rest } = { ...createCharacterDraft([]), ...patch };
  return { ...rest, spot: spot ?? [0, 0] };
}

describe("createCharacterDraft", () => {
  it("starts from the very same defaults the object factory would hand out", () => {
    const draft = createCharacterDraft([]);
    const made = createPrevizObject("character", []);

    // 两条创建路径（工具栏直接新建 / 对话框建）必须给出同一个人。任何一处默认值只改
    // 一边，用户就会发现「从对话框建出来的人跟直接建的不一样」，而两处都没写错字。
    expect(draft.name).toBe(made.name);
    expect(draft.color).toBe(made.color);
    expect(draft.bodyType).toBe(made.bodyType);
    expect(draft.heightCm).toBe(made.heightCm);
    expect(draft.basePoseId).toBe(made.basePoseId);
    expect(draft.poseAdjust).toEqual(made.poseAdjust);
    expect(draft.heightPolicy).toBe(made.heightPolicy);
  });

  it("leaves the spot unpicked so the create button starts disabled", () => {
    const draft = createCharacterDraft([]);

    // 兜一个 [0, 0] 出来的话，用户不点俯视图直接按「创建」会得到一个站在世界原点的人，
    // 而他从没表达过这个意图。
    expect(draft.spot).toBeNull();
    expect(isPlacedCharacterDraft(draft)).toBe(false);
  });

  it("advances the name and the colour past the characters already in the scene", () => {
    const first = createPrevizObject("character", []);
    const objects: PrevizObject[] = [first];

    const draft = createCharacterDraft(objects);

    expect(draft.name).not.toBe(first.name);
    expect(draft.color).not.toBe(first.color);
  });
});

describe("clampCharacterDraft", () => {
  it("pulls the height back into the range the capsule and the rig both use", () => {
    // 上下界读的是 `PREVIZ_HEIGHT_CM_RANGE`（domain/objects.ts），也就是 parseScene、
    // 占位胶囊与 `applyBodyScale` 三处共用的那一份。这里不另立一套。
    expect(clampCharacterDraft(placed({ heightCm: 1000 })).heightCm).toBe(PREVIZ_MAX_HEIGHT_CM);
    expect(clampCharacterDraft(placed({ heightCm: 1 })).heightCm).toBe(PREVIZ_MIN_HEIGHT_CM);
    // 非有限值落回默认身高而不是某个边界：数字输入框空着时读出来就是 NaN。
    expect(clampCharacterDraft(placed({ heightCm: Number.NaN })).heightCm).toBe(
      PREVIZ_DEFAULT_HEIGHT_CM,
    );
  });

  it("pulls each pose adjust axis back into its own asymmetric range", () => {
    // 三条区间各不相同（前倾 -30..45 / 转身 -60..60 / 侧倾 -35..35），共用一条会让
    // 「前倾 -45」这种做不出来的角度悄悄通过。
    const clamped = clampCharacterDraft(
      placed({ poseAdjust: { pitch: -90, turn: 900, lean: Number.NaN } }),
    );

    expect(clamped.poseAdjust).toEqual({ pitch: -30, turn: 60, lean: 0 });
  });

  it("keeps the picked spot exactly where the top-down map put it", () => {
    // 俯视图刻意不把点夹回地块范围（见 `PrevizTopDownPicker`）：地块是按现有对象算出来
    // 的，夹回去等于禁止用户把新人物摆在所有人的外面。夹取在这里再补一次就白做了。
    const draft = placed({ spot: [-99, 123.5] });

    expect(clampCharacterDraft(draft).spot).toEqual([-99, 123.5]);
  });
});

describe("characterDraftOverrides", () => {
  it("stands the character on the picked spot with its feet on the grid", () => {
    const overrides = characterDraftOverrides(placed({ spot: [2, -3] }));

    // 对象节点的原点就在脚底：占位胶囊自己以中心为原点，靠 `yOffset = height / 2`
    // 抬起来（见 `sceneGraph.createCharacterPlaceholder`）。所以 y 取 0 是「站在地面上」，
    // 不是「腰埋在地里」。
    expect(overrides.transform?.position).toEqual([2, 0, -3]);
    expect(overrides.transform?.rotation).toEqual([0, 0, 0]);
    expect(overrides.transform?.scale).toEqual([1, 1, 1]);
  });

  it("seeds the locked plane at the layer the character was created on", () => {
    const overrides = characterDraftOverrides(placed({ spot: [2, -3] }));

    // 用户建完人再切到「锁定平面」时，锁的该是他刚建人的那一层，而不是一个跟他无关的 0。
    // 这两个数当前恰好都是 0，所以断言的是「同一个数」而不是各写一个字面量。
    expect(overrides.planeY).toBe(overrides.transform?.position[1]);
  });

  it("carries the whole property sheet across", () => {
    const overrides = characterDraftOverrides(
      placed({
        name: "阿岩",
        color: "#123456",
        bodyType: "tall",
        heightCm: 190,
        basePoseId: "sitting",
        poseAdjust: { pitch: 10, turn: -20, lean: 5 },
        heightPolicy: "ground",
      }),
    );

    expect(overrides).toMatchObject({
      name: "阿岩",
      color: "#123456",
      bodyType: "tall",
      heightCm: 190,
      basePoseId: "sitting",
      poseAdjust: { pitch: 10, turn: -20, lean: 5 },
      heightPolicy: "ground",
    });
  });

  it("clamps on the way out even though the dialog kept the raw keystrokes", () => {
    const overrides = characterDraftOverrides(
      placed({ heightCm: 1000, poseAdjust: { pitch: 999, turn: 0, lean: 0 } }),
    );

    // 数字输入框存的是用户敲进去的原样（删空再重输才用得下去），收敛推迟到这个出口。
    expect(overrides.heightCm).toBe(PREVIZ_MAX_HEIGHT_CM);
    expect(overrides.poseAdjust?.pitch).toBe(45);
  });

  it("drops a blank name so the factory's 人物 N still wins", () => {
    const overrides = characterDraftOverrides(placed({ name: "   " }));

    // `createPrevizObject` 用 `withoutUndefined` 把值为 undefined 的键滤掉，所以交一个
    // undefined 就等于「用工厂算出来的编号名」。写一个空串进去的话，图层面板上会多出
    // 一行没有标签的条目。
    expect(overrides.name).toBeUndefined();
    expect(createPrevizObject("character", [], overrides).name).toBe(
      createPrevizObject("character", []).name,
    );
  });

  it("hands the object factory something that lands where the user pointed", () => {
    const draft = placed({ spot: [1.5, -2.5], heightCm: 190, bodyType: "capsule" });

    const made = createPrevizObject("character", [], characterDraftOverrides(draft));

    expect(made.transform.position).toEqual([1.5, 0, -2.5]);
    expect(made.heightCm).toBe(190);
    expect(made.bodyType).toBe("capsule");
  });

  it("refuses an unpicked draft at compile time", () => {
    const draft = createCharacterDraft([]);

    // 这条用例是编译期断言：`spot` 还可能是 null 的草稿换不出 overrides。少了这道收窄，
    // 「没点位就按创建」只能靠调用方自己记得挡，而挡漏了的表现是人静静地站在原点。
    // @ts-expect-error spot 可能是 null 的草稿不接
    expect(() => characterDraftOverrides(draft)).toBeTypeOf("function");

    if (isPlacedCharacterDraft(draft)) throw new Error("unreachable");
  });

  it("narrows a picked draft so the same call type-checks", () => {
    const draft: PrevizCharacterDraft = { ...createCharacterDraft([]), spot: [4, 5] };

    // 反向：点过位之后同一个调用必须过——收窄写成「只有字面量才行」的话，对话框里
    // 那份 state 就永远递不进来。
    expect(isPlacedCharacterDraft(draft)).toBe(true);
    if (!isPlacedCharacterDraft(draft)) return;
    expect(characterDraftOverrides(draft).transform?.position).toEqual([4, 0, 5]);
  });
});
