// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrevizImageSize } from "@/features/previz/domain/blockoutImage";
import {
  PrevizBlockoutDialog,
  type PrevizBlockoutDialogProps,
} from "@/features/previz/ui/PrevizBlockoutDialog";
import type { PrevizHeldBlockout } from "@/features/previz/blockoutLanding";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";

type CostResult = { data?: { data: { display: string } }; error?: unknown };
const useGenerationCreditCost = vi.fn<(...args: unknown[]) => CostResult>(() => ({
  data: { data: { display: "12" } },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));
vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (...args: unknown[]) => useGenerationCreditCost(...args),
}));
// 真的那个在 CE 运行时下什么都不画；这里只关心对话框把哪段文字交给了它。
vi.mock("@/components/credit-cost-inline", () => ({
  CreditCostInline: ({ display }: { display?: string | null }) =>
    display ? <span data-testid="cost">{display}</span> : null,
}));

const HELD: PrevizHeldBlockout = {
  jobId: "job-1",
  rejection: { reason: "primitive-limit", missing: 5, limit: 150 },
};

function image(name = "room.png", bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function setup(overrides: Partial<PrevizBlockoutDialogProps> = {}) {
  const handlers = { onStart: vi.fn(), onRetryImport: vi.fn(), onClose: vi.fn() };
  const measureImage = vi.fn<(file: File) => Promise<PrevizImageSize | null>>(async () => ({
    width: 1920,
    height: 1080,
  }));
  const props: PrevizBlockoutDialogProps = {
    open: true,
    stage: "idle",
    held: null,
    hasExisting: false,
    measureImage,
    ...handlers,
    ...overrides,
  };
  const view = render(<PrevizBlockoutDialog {...props} />);
  return { ...handlers, measureImage, props, ...view };
}

const picker = () => screen.getByLabelText("previz.blockout.pick") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: "previz.blockout.submit" });

async function pick(file: File) {
  // `fireEvent` 而不是 `user.upload`：后者会按 accept 把不合格的文件先滤掉，
  // 而拖进来的、或者从「所有文件」里选的文件不经过那层过滤。
  await act(async () => {
    fireEvent.change(picker(), { target: { files: [file] } });
  });
}

const dialog = () => screen.getByRole("dialog", { name: "previz.blockout.title" });
const dropZone = () => screen.getByTestId("previz-blockout-drop-zone");

/** 浏览器拖文件时 `types` 里有一项 "Files"；拖一段文字、一个链接时没有。 */
function dragged(files: File[], types: string[] = ["Files"]) {
  return { dataTransfer: { files, types } };
}

async function drop(files: File[], types?: string[]) {
  let notCancelled = true;
  await act(async () => {
    notCancelled = fireEvent.drop(dialog(), dragged(files, types));
  });
  return { cancelled: !notCancelled };
}

beforeEach(() => {
  useGenerationCreditCost.mockReset().mockReturnValue({ data: { data: { display: "12" } } });
});

describe("PrevizBlockoutDialog", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as a focusable dialog that explains what kind of picture works", () => {
    setup();

    const dialog = screen.getByRole("dialog", { name: "previz.blockout.title" });
    expect(dialog).toHaveAttribute("tabindex", "-1");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const guide = screen.getByRole("list", { name: "previz.blockout.guide.title" });
    expect(within(guide).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "previz.blockout.guide.space",
      "previz.blockout.guide.floor",
      "previz.blockout.guide.framing",
      "previz.blockout.guide.occlusion",
    ]);
  });

  it("offers the four formats the backend takes", () => {
    setup();

    expect(picker()).toHaveAttribute("accept", ".png,.jpg,.jpeg,.webp");
  });

  it("cannot start without a picture", () => {
    setup();

    expect(submit()).toBeDisabled();
  });

  it("starts with the picked picture, the note and replace by default", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();
    const file = image();

    await pick(file);
    expect(screen.getByText("room.png")).toBeInTheDocument();
    await user.type(screen.getByLabelText("previz.blockout.description"), "层高 3 米");
    await user.click(submit());

    expect(onStart).toHaveBeenCalledTimes(1);
    const request = onStart.mock.calls[0]![0];
    expect(request.file).toBe(file);
    expect(request.description).toBe("层高 3 米");
    expect(request.pictureCheck).toBe(false);
    expect(request.mode).toBe("replace");
  });

  it("sends the picture check only when the box is ticked", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();

    await pick(image());
    const box = screen.getByRole("checkbox", { name: "previz.blockout.pictureCheck" });
    expect(box).not.toBeChecked();
    await user.click(box);
    await user.click(submit());

    expect(onStart.mock.calls[0]![0].pictureCheck).toBe(true);
  });

  // 读 `value` 验不出来：jsdom 里用 `fireEvent` 塞进去的文件不进 input 自己的文件表，
  // `value` 从头到尾都是空串，清不清都一样。盯的是「写过一次空串」这个动作本身——
  // 浏览器里不清的话，同一张图选第二次不触发 change。
  it("lets the same file be picked twice in a row", async () => {
    setup();
    // 盯这个节点自己的 setter，不盯原型上的：React 接管受控输入时在节点上另挂了一份
    // `value`，里头调的是它当时存下来的原型 setter，事后再去换原型上的已经拦不到了。
    const clear = vi.spyOn(picker(), "value", "set");

    await pick(image());

    expect(clear).toHaveBeenCalledWith("");
  });

  // 去空格、截长度归生成流程管（见 use-blockout-generation 那组用例），对话框原样交出去：
  // 两头各修一遍的话，改规则时总会漏掉一头。
  it("hands the note over as typed", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();

    await pick(image());
    await user.type(screen.getByLabelText("previz.blockout.description"), " 层高 3 米 ");
    await user.click(submit());

    expect(onStart.mock.calls[0]![0].description).toBe(" 层高 3 米 ");
  });

  it.each([
    ["room.gif", 2048, "previz.blockout.badExtension"],
    ["room.png", 21 * 1024 * 1024, "previz.blockout.tooLarge"],
  ])("turns away %s (%d bytes) on the spot", async (name, bytes, message) => {
    const { onStart, measureImage } = setup();

    await pick(image(name, bytes));

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(submit()).toBeDisabled();
    expect(measureImage).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("forgets the refusal once a usable picture is picked", async () => {
    setup();
    await pick(image("room.gif"));

    await pick(image("room.png"));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(submit()).toBeEnabled();
  });

  it("drops the earlier picture when the next pick is refused", async () => {
    setup();
    await pick(image("room.png"));

    await pick(image("room.gif"));

    expect(screen.queryByText("room.png")).toBeNull();
    expect(submit()).toBeDisabled();
  });
});

describe("PrevizBlockoutDialog hints never block", () => {
  it.each([
    [{ width: 400, height: 300 }, ["previz.blockout.hint.small"]],
    [{ width: 3000, height: 1000 }, ["previz.blockout.hint.wide"]],
    [{ width: 1000, height: 3000 }, ["previz.blockout.hint.tall"]],
    [{ width: 1500, height: 300 }, ["previz.blockout.hint.small", "previz.blockout.hint.wide"]],
  ])("warns about %o and still lets you start", async (size, expected) => {
    const user = userEvent.setup();
    const { onStart } = setup({ measureImage: async () => size });

    await pick(image());

    const hints = await screen.findByRole("list", { name: "previz.blockout.hint.title" });
    expect(within(hints).getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      expected,
    );
    expect(submit()).toBeEnabled();
    await user.click(submit());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a picture that is fine", async () => {
    setup();

    await pick(image());

    expect(screen.queryByRole("list", { name: "previz.blockout.hint.title" })).toBeNull();
    expect(submit()).toBeEnabled();
  });

  it.each([
    ["cannot be measured", async () => null],
    [
      "fails to decode",
      async () => {
        throw new Error("decode failed");
      },
    ],
  ])("says so and still lets you start when the picture %s", async (_label, measureImage) => {
    setup({ measureImage });

    await pick(image());

    const hints = await screen.findByRole("list", { name: "previz.blockout.hint.title" });
    expect(within(hints).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "previz.blockout.hint.unreadable",
    ]);
    expect(submit()).toBeEnabled();
  });

  it("does not show the first picture's hints on the second picture", async () => {
    let finishFirst!: (size: PrevizImageSize) => void;
    const measureImage = vi
      .fn<(file: File) => Promise<PrevizImageSize | null>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockImplementationOnce(async () => ({ width: 1920, height: 1080 }));
    setup({ measureImage });

    await pick(image("tiny.png"));
    await pick(image("fine.png"));
    await act(async () => finishFirst({ width: 100, height: 100 }));

    expect(screen.getByText("fine.png")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "previz.blockout.hint.title" })).toBeNull();
  });
});

describe("PrevizBlockoutDialog note", () => {
  it("caps the note at what the backend accepts and counts it", async () => {
    const user = userEvent.setup();
    setup();

    const note = screen.getByLabelText("previz.blockout.description");
    expect(note).toHaveAttribute("maxlength", "2000");
    await user.type(note, "门宽 0.9");

    expect(screen.getByText("6 / 2000")).toBeInTheDocument();
  });
});

describe("PrevizBlockoutDialog replace or append", () => {
  it("does not ask when the scene has no blockout yet", () => {
    setup();

    expect(screen.queryByRole("group", { name: "previz.blockout.mode.title" })).toBeNull();
  });

  it("asks when there is one, replace first", () => {
    setup({ hasExisting: true });

    const group = screen.getByRole("group", { name: "previz.blockout.mode.title" });
    expect(
      within(group).getByRole("button", { name: "previz.blockout.mode.replace" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(group).getByRole("button", { name: "previz.blockout.mode.append" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("starts in append when that is chosen", async () => {
    const user = userEvent.setup();
    const { onStart } = setup({ hasExisting: true });
    await pick(image());

    await user.click(screen.getByRole("button", { name: "previz.blockout.mode.append" }));
    await user.click(submit());

    expect(onStart.mock.calls[0]![0].mode).toBe("append");
  });
});

describe("PrevizBlockoutDialog while working", () => {
  it.each(["uploading", "generating"] as const)("locks the form while %s", async (stage) => {
    const { rerender, props, onStart } = setup();
    await pick(image());

    rerender(<PrevizBlockoutDialog {...props} stage={stage} />);

    expect(screen.getByRole("status")).toHaveTextContent(`previz.blockout.stage.${stage}`);
    // 关掉对话框这次结果就不要了、积分照扣：这句话必须在看得见的地方。
    expect(screen.getByText("previz.blockout.closeDiscards")).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(picker()).toBeDisabled();
    expect(screen.getByLabelText("previz.blockout.description")).toBeDisabled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("keeps the picture after a failed run so it can be sent again", async () => {
    const user = userEvent.setup();
    const { rerender, props, onStart } = setup();
    await pick(image());
    rerender(<PrevizBlockoutDialog {...props} stage="generating" />);

    rerender(<PrevizBlockoutDialog {...props} stage="idle" />);

    expect(screen.getByText("room.png")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(submit());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("closes from the header button", async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ stage: "generating" });

    await user.click(screen.getByRole("button", { name: "previz.blockout.close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PrevizBlockoutDialog price", () => {
  it("quotes one blockout job on the canvas surface", () => {
    setup();

    expect(useGenerationCreditCost).toHaveBeenCalledWith("feature", "freezone.image_to_blockout", {
      surface: "canvas",
      quantity: 1,
      params: { operation: "image_to_blockout" },
    });
    expect(screen.getByTestId("cost")).toHaveTextContent("12");
  });

  it("cannot start while the price rule is missing", async () => {
    useGenerationCreditCost.mockReturnValue({
      error: new BillingRuleNotConfiguredError("rule missing", 409),
    });
    setup();

    await pick(image());

    expect(screen.getByTestId("cost")).toHaveTextContent("common.billingRuleNotConfiguredShort");
    expect(submit()).toBeDisabled();
  });

  it("can start when the quote merely failed to load", async () => {
    useGenerationCreditCost.mockReturnValue({ error: new Error("network") });
    setup();

    await pick(image());

    expect(screen.queryByTestId("cost")).toBeNull();
    expect(submit()).toBeEnabled();
  });
});

describe("PrevizBlockoutDialog with a result that did not fit", () => {
  it("explains what is missing and offers to import again for free", async () => {
    const user = userEvent.setup();
    const { onRetryImport, onStart } = setup({ held: HELD, hasExisting: true });

    const notice = screen.getByRole("region", { name: "previz.blockout.held.title" });
    expect(notice).toHaveTextContent(
      'previz.blockout.rejected.primitiveLimit:{"missing":5,"limit":150}',
    );
    expect(notice).toHaveTextContent("previz.blockout.held.free");
    await user.click(screen.getByRole("button", { name: "previz.blockout.mode.append" }));
    await user.click(screen.getByRole("button", { name: "previz.blockout.held.retry" }));

    expect(onRetryImport).toHaveBeenCalledWith("append");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("shows no such notice otherwise", () => {
    setup();

    expect(screen.queryByRole("region", { name: "previz.blockout.held.title" })).toBeNull();
    expect(screen.queryByRole("button", { name: "previz.blockout.held.retry" })).toBeNull();
  });

  it.each([
    [{ reason: "camera-limit", missing: 1, limit: 30 }, 'previz.blockout.rejected.cameraLimit:{"missing":1,"limit":30}'],
    [{ reason: "too-large", bytes: 9_000_000 }, "previz.blockout.rejected.tooLarge"],
  ] as const)("explains %o", (rejection, message) => {
    setup({ held: { ...HELD, rejection } });

    expect(screen.getByRole("region", { name: "previz.blockout.held.title" })).toHaveTextContent(
      message,
    );
  });
});

describe("PrevizBlockoutDialog drag and drop", () => {
  it("says a picture can be dragged in", () => {
    setup();

    expect(dropZone()).toHaveTextContent("previz.blockout.dropHint");
  });

  it("starts with a picture dropped anywhere on the dialog", async () => {
    const user = userEvent.setup();
    const { onStart } = setup();
    const file = image("dropped.png");

    await drop([file]);

    expect(screen.getByText("dropped.png")).toBeInTheDocument();
    await user.click(submit());
    expect(onStart.mock.calls[0]![0].file).toBe(file);
  });

  it("measures a dropped picture like a picked one", async () => {
    setup({ measureImage: async () => ({ width: 400, height: 300 }) });

    await drop([image()]);

    const hints = await screen.findByRole("list", { name: "previz.blockout.hint.title" });
    expect(within(hints).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "previz.blockout.hint.small",
    ]);
  });

  it("turns away a dropped file the backend would not take", async () => {
    setup();

    await drop([image("room.gif")]);

    expect(screen.getByRole("alert")).toHaveTextContent("previz.blockout.badExtension");
    expect(submit()).toBeDisabled();
  });

  it("takes the first picture when several are dropped at once", async () => {
    setup();

    await drop([image("first.png"), image("second.png")]);

    expect(screen.getByText("first.png")).toBeInTheDocument();
    expect(screen.queryByText("second.png")).toBeNull();
  });

  it("lights up while a file hovers and goes dark when it leaves", () => {
    setup();
    expect(dropZone()).toHaveAttribute("data-dragging", "false");

    fireEvent.dragEnter(dialog(), dragged([]));
    expect(dropZone()).toHaveAttribute("data-dragging", "true");
    expect(dropZone()).toHaveTextContent("previz.blockout.dropNow");

    fireEvent.dragLeave(dialog(), dragged([]));
    expect(dropZone()).toHaveAttribute("data-dragging", "false");
  });

  // 从对话框的一个子元素拖到另一个子元素上，浏览器先发 enter 再发 leave；
  // 只认最后一次 leave 的话高亮会在对话框里头一路闪。
  it("stays lit while the file moves between parts of the dialog", () => {
    setup();

    fireEvent.dragEnter(dialog(), dragged([]));
    fireEvent.dragEnter(screen.getByLabelText("previz.blockout.description"), dragged([]));
    fireEvent.dragLeave(dialog(), dragged([]));

    expect(dropZone()).toHaveAttribute("data-dragging", "true");
  });

  it("goes dark once the file is dropped", async () => {
    setup();
    fireEvent.dragEnter(dialog(), dragged([]));

    await drop([image()]);

    expect(dropZone()).toHaveAttribute("data-dragging", "false");
  });

  it("does not light up for dragged text", async () => {
    setup();

    fireEvent.dragEnter(dialog(), dragged([], ["text/plain"]));
    expect(dropZone()).toHaveAttribute("data-dragging", "false");

    await drop([], ["text/plain"]);
    expect(submit()).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // 不拦的话浏览器会直接打开拖进来的图，整个编辑器连同没保存的场景一起没了。
  it.each(["dragOver", "drop"] as const)("keeps the browser from opening the file on %s", (name) => {
    setup();

    const notCancelled = fireEvent[name](dialog(), dragged([image()]));

    expect(notCancelled).toBe(false);
  });

  it.each(["uploading", "generating"] as const)(
    "leaves the picture alone when one is dropped while %s",
    async (stage) => {
      const { rerender, props } = setup();
      await pick(image("room.png"));
      rerender(<PrevizBlockoutDialog {...props} stage={stage} />);

      fireEvent.dragEnter(dialog(), dragged([]));
      expect(dropZone()).toHaveAttribute("data-dragging", "false");
      const { cancelled } = await drop([image("other.png")]);

      expect(cancelled).toBe(true);
      expect(screen.getByText("room.png")).toBeInTheDocument();
      expect(screen.queryByText("other.png")).toBeNull();
    },
  );

  // 编辑器挂在画布节点底下，React 的合成事件顺着组件树冒泡、不看 DOM 在哪：
  // 不截住的话画布会把这张图当成新节点收走，还会亮起它自己的「释放以添加」蒙层。
  it("keeps the drag from reaching whatever the editor is mounted in", async () => {
    const outer = {
      onDragEnter: vi.fn(),
      onDragOver: vi.fn(),
      onDragLeave: vi.fn(),
      onDrop: vi.fn(),
    };
    const handlers = { onStart: vi.fn(), onRetryImport: vi.fn(), onClose: vi.fn() };
    render(
      <div {...outer}>
        <PrevizBlockoutDialog open stage="idle" held={null} hasExisting={false} {...handlers} />
      </div>,
    );

    fireEvent.dragEnter(dialog(), dragged([]));
    fireEvent.dragOver(dialog(), dragged([]));
    fireEvent.dragLeave(dialog(), dragged([]));
    await drop([image()]);

    for (const handler of Object.values(outer)) expect(handler).not.toHaveBeenCalled();
  });
});
