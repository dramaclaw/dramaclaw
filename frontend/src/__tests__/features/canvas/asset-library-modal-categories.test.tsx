// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 资产库弹窗：左侧文件夹控制存放范围，右侧类目只筛选当前范围内的资产。
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

// Budget for complete component flows; per-step waits and request deadlines stay unchanged.
vi.setConfig({ testTimeout: 15_000 });
afterAll(() => vi.resetConfig());

const fetchFreezoneVideoCharacterLibrary = vi.fn();
const syncFreezoneAssetLibraryFromMainline = vi.fn();
const fetchFreezoneAssetLibraryFolders = vi.fn();
const createFreezoneAssetLibraryFolder = vi.fn();
const deleteFreezoneVideoCharacterLibraryItem = vi.fn();
const updateFreezoneAssetLibraryFolder = vi.fn();
const deleteFreezoneAssetLibraryFolder = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoCharacterLibrary: (...args: unknown[]) =>
    fetchFreezoneVideoCharacterLibrary(...args),
  syncFreezoneAssetLibraryFromMainline: (...args: unknown[]) =>
    syncFreezoneAssetLibraryFromMainline(...args),
  fetchFreezoneAssetLibraryFolders: (...args: unknown[]) =>
    fetchFreezoneAssetLibraryFolders(...args),
  createFreezoneAssetLibraryFolder: (...args: unknown[]) =>
    createFreezoneAssetLibraryFolder(...args),
  deleteFreezoneVideoCharacterLibraryItem: (...args: unknown[]) =>
    deleteFreezoneVideoCharacterLibraryItem(...args),
  updateFreezoneAssetLibraryFolder: (...args: unknown[]) =>
    updateFreezoneAssetLibraryFolder(...args),
  deleteFreezoneAssetLibraryFolder: (...args: unknown[]) =>
    deleteFreezoneAssetLibraryFolder(...args),
}));

import { AssetLibraryModal } from "@/features/canvas/ui/AssetLibraryModal";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { normalizeLibraryList } from "@/features/canvas/ui/assetLibraryItems";

const VOICE_ASSET_ID = "c9706788-b922-4e83-aa62-31e089530a7a";
const NEW_VOICE_ASSET_ID = "5509634f-335e-4a2e-a9f2-85b5b2a02f3d";
const SAVED_VOICE = {
  id: `voice-design:${VOICE_ASSET_ID}`,
  name: "旧设计声线",
  media: "audio",
  source: "upload",
  category: "audio",
  folder: "audio",
  audio_url: "/static/assets/audio/voice-design/saved.mp3",
  voice_design: {
    asset_id: VOICE_ASSET_ID,
    name: "旧设计声线",
    url: "/static/assets/audio/voice-design/saved.mp3",
    sha256: "a".repeat(64),
    duration_seconds: 4.5,
    model: null,
  },
};
const VOICE_LIBRARY = [
  {
    id: "mainline:character:hero:voice:default",
    name: "主线角色声线",
    media: "audio",
    source: "character",
    category: "character",
    folder: "mainline",
    audio_url: "/static/characters/hero/voice_default.mp3",
  },
  {
    ...SAVED_VOICE,
    id: `voice-design:${NEW_VOICE_ASSET_ID}`,
    name: "新设计声线",
    category: "character",
    folder: "character",
    audio_url: "/static/assets/audio/voice-design/new.mp3",
    voice_design: {
      ...SAVED_VOICE.voice_design,
      asset_id: NEW_VOICE_ASSET_ID,
      name: "新设计声线",
      url: "/static/assets/audio/voice-design/new.mp3",
    },
  },
  SAVED_VOICE,
  {
    id: "sfx", name: "普通音效", media: "audio", source: "upload",
    category: "audio", folder: "audio", audio_url: "/static/step.mp3",
  },
];

const LIBRARY = [
  {
    id: "mainline:scene:厨房",
    name: "厨房",
    media: "image",
    source: "scene",
    image_urls: ["/static/kitchen.png"],
  },
  {
    id: "up-1",
    name: "参考图A",
    media: "image",
    source: "upload",
    image_urls: ["/static/a.png"],
  },
  {
    id: "up-2",
    name: "赛博霓虹",
    media: "image",
    source: "upload",
    category: "style",
    image_urls: ["/static/b.png"],
  },
  {
    id: "up-3",
    name: "脚步声",
    media: "audio",
    source: "upload",
    category: "audio",
    audio_url: "/static/step.mp3",
  },
];

function renderModal(props: Partial<React.ComponentProps<typeof AssetLibraryModal>> = {}) {
  return render(
    <>
      <ConfirmDialogHost />
      <AssetLibraryModal mode="manage" open project="demo" onClose={() => {}} {...props} />
    </>,
  );
}

/** 删除确认走 AlertDialog（不是 window.confirm），点掉它的「删除」放行。 */
async function acceptDeleteConfirm() {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
}

/** 取消：按「不是删除的那个」找，取消文案走 i18n，测试里没初始化语言包。 */
async function dismissConfirm(dialog: HTMLElement) {
  const cancel = within(dialog)
    .getAllByRole("button")
    .find((button) => button.textContent !== "删除");
  fireEvent.click(cancel as HTMLElement);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

describe("AssetLibraryModal 类目与文件夹", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: LIBRARY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: LIBRARY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
    deleteFreezoneVideoCharacterLibraryItem.mockResolvedValue({ ok: true });
  });

  it("默认展示真正的全部资产，文件夹独立放在左侧导航", async () => {
    renderModal();

    expect(await screen.findByRole("button", { name: "文件夹 主线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件夹 待分类资产" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件夹 风格" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部资产" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByText("厨房")).toBeInTheDocument();
    expect(screen.getByText("参考图A")).toBeInTheDocument();
    // 高频写操作直接放在右上角，不再藏进只有两个选项的「新建」菜单。
    expect(screen.getByRole("button", { name: "批量删除" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建文件夹" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传资产" })).toBeInTheDocument();
  });

  it("打开资产库只读，只有明确同步才写入主线素材", async () => {
    renderModal();
    await screen.findByText("参考图A");
    expect(syncFreezoneAssetLibraryFromMainline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "同步主线" }));
    await waitFor(() => expect(syncFreezoneAssetLibraryFromMainline).toHaveBeenCalledTimes(1));
  });

  it("moves focus into the library, traps both Tab directions and restores its opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开项目库</button><button>背景按钮</button><AssetLibraryModal mode="manage" project="demo" open={open} onClose={() => setOpen(false)} /></>;
    }
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开项目库" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "资产库" });
    await screen.findByText("参考图A");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter(button => !button.disabled && button.tabIndex >= 0);
    const first = controls[0]; const last = controls[controls.length - 1];
    if (!first || !last) throw new Error("Expected library controls");
    last.focus(); await user.tab();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    first.focus(); await user.tab({ shift: true });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps nested upload and folder controls focused and closes only the top layer", async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByText("参考图A");
    const uploadOpener = screen.getByRole("button", { name: "上传资产" });
    await user.click(uploadOpener);
    const upload = await screen.findByRole("dialog", { name: "上传资产" });
    await waitFor(() => expect(upload.contains(document.activeElement)).toBe(true));
    await user.click(within(upload).getByRole("button", { name: "选择保存位置" }));
    await user.click(within(upload).getByRole("button", { name: "新建文件夹" }));
    const folder = await screen.findByRole("dialog", { name: "新建文件夹" });
    const input = within(folder).getByPlaceholderText("请输入文件夹名称");
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "键");
    expect(input).toHaveValue("键");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(upload.contains(document.activeElement)).toBe(true));
    expect(screen.getByRole("dialog", { name: "上传资产" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "上传资产" })).toBeInTheDocument();
    expect(within(upload).queryByRole("button", { name: "新建文件夹" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(uploadOpener).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "资产库" })).toBeInTheDocument();
  });

  it("focuses preview controls and returns to the selected card after Escape", async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByText("参考图A");
    const detailsOpener = screen.getByRole("button", { name: "查看 参考图A 详情" });
    await user.click(detailsOpener);
    const preview = await screen.findByRole("dialog", { name: "资产详情" });
    await waitFor(() => expect(preview.contains(document.activeElement)).toBe(true));
    expect(within(preview).getByRole("button", { name: "下载" })).toBeEnabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(detailsOpener).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "资产库" })).toBeInTheDocument();
  });

  it("文件夹只改变资产范围，全部资产入口能恢复全量视图", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "文件夹 主线" }));
    expect(await screen.findByText("厨房")).toBeInTheDocument();
    expect(screen.queryByText("参考图A")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全部资产" }));
    expect(await screen.findByText("参考图A")).toBeInTheDocument();
    expect(screen.getByText("厨房")).toBeInTheDocument();
  });

  it("待分类资产文件夹只装没归类的上传", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "文件夹 待分类资产" }));
    expect(await screen.findByText("参考图A")).toBeInTheDocument();
    expect(screen.queryByText("赛博霓虹")).toBeNull();
  });

  it("类目只筛选当前资产范围，不会切回另一种内容层级", async () => {
    renderModal();

    await screen.findByRole("button", { name: "文件夹 主线" });
    fireEvent.click(screen.getByRole("button", { name: "分类 风格" }));
    expect(await screen.findByText("赛博霓虹")).toBeInTheDocument();
    expect(screen.queryByText("参考图A")).toBeNull();
    expect(screen.getByRole("button", { name: "文件夹 待分类资产" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "文件夹 主线" }));
    expect(await screen.findByText("厨房")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "分类 风格" }));
    expect(screen.queryByText("赛博霓虹")).toBeNull();
    expect(screen.getByText("当前分类下没有素材")).toBeInTheDocument();
  });

  it("allowedMedia 只要图片时，音效类目和音频条目都不出现", async () => {
    renderModal({ allowedMedia: ["image"] });

    await screen.findByRole("button", { name: "文件夹 主线" });
    expect(screen.queryByRole("button", { name: "分类 音效" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "文件夹 待分类资产" }));
    expect(await screen.findByText("参考图A")).toBeInTheDocument();
    expect(screen.queryByText("脚步声")).toBeNull();
  });

  it("音频选择器按人物筛出主线和新旧设计声线，按音效只筛出普通音效", async () => {
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: VOICE_LIBRARY });
    const onConfirm = vi.fn();
    renderModal({ mode: "pick", allowedMedia: ["audio"], onConfirm });
    await screen.findByText("旧设计声线");
    fireEvent.click(screen.getByRole("button", { name: "分类 人物" }));
    for (const name of ["主线角色声线", "新设计声线", "旧设计声线"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
      fireEvent.click(screen.getByText(name));
    }
    expect(screen.queryByText("普通音效")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件夹 主线" }));
    expect(screen.getByText("主线角色声线")).toBeInTheDocument();
    expect(screen.queryByText("新设计声线")).toBeNull();
    expect(screen.queryByText("旧设计声线")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部资产" }));
    fireEvent.click(screen.getByRole("button", { name: "分类 音效" }));
    expect(screen.getByText("普通音效")).toBeInTheDocument();
    expect(screen.queryByText("旧设计声线")).toBeNull();
    expect(screen.queryByText("主线角色声线")).toBeNull();
    expect(screen.queryByText("新设计声线")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(onConfirm).toHaveBeenCalledWith(VOICE_LIBRARY.slice(0, 3).map(entry => ({
      media: "audio", name: entry.name, url: entry.audio_url,
    })));
  });

  it.each(["pick", "manage"] as const)("%s模式点击音频背景可选材或打开详情，播放与进度不触发卡片", async (mode) => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: [SAVED_VOICE] });
    const onConfirm = vi.fn();
    const { container } = renderModal({ mode, allowedMedia: ["audio"], onConfirm });
    await screen.findByText(SAVED_VOICE.name);
    const player = container.ownerDocument.querySelector("audio")?.parentElement;
    expect(player).not.toBeNull();
    if (!player) return;
    const play = within(player).getByRole("button");
    fireEvent.click(play);
    fireEvent.click(within(player).getByRole("slider"));
    expect(screen.queryByRole("dialog", { name: "资产详情" })).not.toBeInTheDocument();
    if (mode === "pick") expect(screen.getByRole("button", { name: "确定" })).toBeDisabled();
    fireEvent.click(player);
    if (mode === "pick") {
      expect(screen.getByRole("button", { name: "确定" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "确定" }));
      expect(onConfirm).toHaveBeenCalledWith([{ media: "audio", name: SAVED_VOICE.name, url: SAVED_VOICE.audio_url }]);
    } else {
      expect(await screen.findByRole("dialog", { name: "资产详情" })).toBeInTheDocument();
    }
  });

  it("兼容旧正式设计声线时保留已有和缺省保存位置及原始数据", () => {
    const legacy = { ...SAVED_VOICE, folder: undefined };
    const snapshot = structuredClone([SAVED_VOICE, legacy]);
    const entries = normalizeLibraryList([SAVED_VOICE, legacy]);
    expect(entries.map(({ category, folder }) => ({ category, folder }))).toEqual([
      { category: "character", folder: "audio" },
      { category: "character", folder: "audio" },
    ]);
    expect([SAVED_VOICE, legacy]).toEqual(snapshot);
  });

  it.each([
    { voice_design: true },
    { voice_design: { ...SAVED_VOICE.voice_design, sha256: "invalid" } },
    { voice_design: { ...SAVED_VOICE.voice_design, duration_seconds: 0 } },
    { id: "ordinary-upload" },
    { audio_url: "/static/unrelated.mp3" },
  ])("不把无效或不匹配的设计元数据当成人物 %j", (override) => {
    expect(normalizeLibraryList([{ ...SAVED_VOICE, ...override }])[0]?.category).toBe("audio");
  });

  it("在当前文件夹与分类范围内按名称搜索，并能从空态直接清空", async () => {
    renderModal();
    await screen.findByText("参考图A");

    const search = screen.getByRole("searchbox", { name: "搜索资产" });
    fireEvent.change(search, { target: { value: "赛博" } });

    expect(screen.getByText("赛博霓虹")).toBeInTheDocument();
    expect(screen.queryByText("参考图A")).toBeNull();

    fireEvent.change(search, { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的资产")).toBeInTheDocument();
    const clearButtons = screen.getAllByRole("button", { name: "清空搜索" });
    fireEvent.click(clearButtons[clearButtons.length - 1]!);

    expect(await screen.findByText("参考图A")).toBeInTheDocument();
  });
});

describe("AssetLibraryModal 新建", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: LIBRARY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: LIBRARY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
  });

  it("新建文件夹保存后立刻出现并进到该文件夹", async () => {
    const created = { id: "fld-1", name: "第一集素材" };
    createFreezoneAssetLibraryFolder.mockResolvedValue(created);
    // 建完会重新拉一次文件夹列表。
    fetchFreezoneAssetLibraryFolders
      .mockResolvedValueOnce([])
      .mockResolvedValue([created]);

    renderModal();
    await screen.findByRole("button", { name: "文件夹 主线" });

    fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));

    const input = screen.getByPlaceholderText("请输入文件夹名称");
    fireEvent.change(input, { target: { value: "第一集素材" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(createFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "第一集素材",
      ),
    );
    // 建完直接把左侧范围切到新文件夹，右侧显示对应空状态。
    expect(
      await screen.findByRole("button", { name: "文件夹 第一集素材" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("这里还没有素材")).toBeInTheDocument();
  });

  it("上传资产弹窗要先选保存位置才能保存，主线不在可选之列", async () => {
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([
      { id: "fld-1", name: "第一集素材" },
    ]);
    renderModal();
    await screen.findByRole("button", { name: "文件夹 主线" });

    fireEvent.click(screen.getByRole("button", { name: "上传资产" }));

    // 没选文件、没选保存位置，保存不可用。
    expect(screen.getByRole("button", { name: "上传" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "选择保存位置" }));
    expect(screen.getByRole("button", { name: "待分类资产" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第一集素材" })).toBeInTheDocument();
    // 主线是同步产物，不能当上传目标。
    expect(screen.queryByRole("button", { name: "主线" })).toBeNull();
  });
});

describe("AssetLibraryModal 底部分页", () => {
  // 26 条无标签上传 → 全都落在「待分类资产」里，够翻两页。
  const MANY = Array.from({ length: 26 }, (_, i) => ({
    id: `up-${i + 1}`,
    name: `素材${i + 1}`,
    media: "image",
    source: "upload",
    image_urls: [`/static/${i + 1}.png`],
  }));

  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: MANY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: MANY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
  });

  it("管理态底部只剩分页，没有「确定」", async () => {
    renderModal();

    expect(await screen.findByRole("button", { name: "第 1 页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "每页条数" })).toHaveTextContent(
      "20条/页",
    );
    expect(screen.queryByRole("button", { name: "确定" })).toBeNull();
  });

  it("挑素材给节点用时「确定」还在", async () => {
    renderModal({ mode: "pick", onConfirm: vi.fn() });

    expect(await screen.findByRole("button", { name: "确定" })).toBeInTheDocument();
  });

  it("默认每页 20 条，翻页看后面的", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "文件夹 待分类资产" }));
    expect(await screen.findByText("素材1")).toBeInTheDocument();
    expect(screen.getByText("素材20")).toBeInTheDocument();
    expect(screen.queryByText("素材21")).toBeNull();
    // 26 条 → 2 页。
    expect(screen.queryByRole("button", { name: "第 3 页" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("素材21")).toBeInTheDocument();
    expect(screen.queryByText("素材1")).toBeNull();
  });

  it("改每页条数后回到第一页并一次列全", async () => {
    renderModal();

    fireEvent.click(await screen.findByRole("button", { name: "文件夹 待分类资产" }));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("素材21")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "每页条数" }));
    fireEvent.click(screen.getByRole("button", { name: "40条/页" }));

    expect(await screen.findByText("素材1")).toBeInTheDocument();
    expect(screen.getByText("素材26")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "第 2 页" })).toBeNull();
  });
});

describe("AssetLibraryModal 文件夹操作", () => {
  const CUSTOM = {
    id: "fld-1",
    name: "第一集素材",
    created_at: "2026-08-12T10:20:30",
  };
  const FILED = [
    ...LIBRARY,
    {
      id: "up-4",
      name: "女主定妆",
      media: "image",
      source: "upload",
      category: "character",
      folder: "fld-1",
      image_urls: ["/static/c.png"],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: FILED });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: FILED });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([CUSTOM]);
    updateFreezoneAssetLibraryFolder.mockResolvedValue(CUSTOM);
    deleteFreezoneAssetLibraryFolder.mockResolvedValue({ deleted_items: 1 });
  });

  it.each([
    { action: "修改封面", close: "Escape" },
    { action: "修改封面", close: "保存" },
    { action: "重命名", close: "Escape" },
    { action: "重命名", close: "保存" },
  ])("returns focus inside the library after $action / $close", async ({ action, close }) => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>打开项目库</button><button>背景按钮</button><AssetLibraryModal mode="manage" project="demo" open={open} onClose={() => setOpen(false)} /></>;
    }
    if (action === "重命名" && close === "保存") {
      fetchFreezoneAssetLibraryFolders.mockResolvedValueOnce([CUSTOM])
        .mockResolvedValue([{ ...CUSTOM, name: "第一集" }]);
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "打开项目库" }));
    const library = await screen.findByRole("dialog", { name: "资产库" });
    const more = await screen.findByRole("button", { name: "第一集素材 更多操作" });
    await user.click(more);
    await user.click(screen.getByRole("button", { name: action }));
    const child = await screen.findByRole("dialog", { name: action });
    await waitFor(() => expect(child.contains(document.activeElement)).toBe(true));
    if (close === "Escape") {
      await user.keyboard("{Escape}");
      expect(updateFreezoneAssetLibraryFolder).not.toHaveBeenCalled();
    } else {
      if (action === "重命名") {
        const input = within(child).getByPlaceholderText("请输入文件夹名称");
        await user.clear(input);
        await user.type(input, "第一集");
      } else {
        await user.click(within(child).getByRole("button", { name: "选择封面 女主定妆" }));
      }
      await user.click(within(child).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(updateFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo", "fld-1", action === "重命名" ? { name: "第一集" } : { cover: "/static/c.png" },
      ));
      if (action === "重命名")
        await screen.findByRole("button", { name: "第一集 更多操作" });
    }
    await waitFor(() => expect(screen.queryByRole("dialog", { name: action })).toBeNull());
    expect(screen.getByRole("dialog", { name: "资产库" })).toBe(library);
    await waitFor(() => expect(more).toHaveFocus());
    await user.tab();
    expect(library.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(library.contains(document.activeElement)).toBe(true);
    const controls = [...library.querySelectorAll<HTMLButtonElement>("button")].filter(button => !button.disabled && button.tabIndex >= 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) throw new Error("Expected library controls");
    last.focus(); await user.tab();
    await waitFor(() => expect(library.contains(document.activeElement)).toBe(true));
    first.focus(); await user.tab({ shift: true });
    await waitFor(() => expect(library.contains(document.activeElement)).toBe(true));
  });

  it("只有自建文件夹带「…」菜单，系统文件夹没有", async () => {
    renderModal();

    expect(
      await screen.findByRole("button", { name: "第一集素材 更多操作" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "主线 更多操作" })).toBeNull();
    // 名字挪到卡片下边，条数不再显示，建夹日期显示在名字下面一行。
    expect(screen.queryByText("1 个")).toBeNull();
    expect(screen.getByText("2026-08-12")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "待分类资产 更多操作" }),
    ).toBeNull();
  });

  it("「发送到画布」把整个文件夹交给调用方并关掉弹窗", async () => {
    const onSendFolderToCanvas = vi.fn();
    const onClose = vi.fn();
    renderModal({ onSendFolderToCanvas, onClose });

    // 每个非空文件夹导航项旁都有一个，按该行圈定再点。
    const folderButton = await screen.findByRole("button", {
      name: "文件夹 第一集素材",
    });
    fireEvent.click(
      within(folderButton.parentElement as HTMLElement).getByRole("button", {
        name: "发送到画布",
      }),
    );

    expect(onSendFolderToCanvas).toHaveBeenCalledTimes(1);
    expect(onSendFolderToCanvas.mock.calls[0][0]).toMatchObject({
      key: "fld-1",
      label: "第一集素材",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("重命名走 PATCH，只改名字", async () => {
    renderModal();

    fireEvent.click(
      await screen.findByRole("button", { name: "第一集素材 更多操作" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));

    const input = screen.getByPlaceholderText("请输入文件夹名称");
    expect(input).toHaveValue("第一集素材");
    fireEvent.change(input, { target: { value: "第一集" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(updateFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "fld-1",
        { name: "第一集" },
      ),
    );
  });

  it("改封面从文件夹内的图片里挑", async () => {
    renderModal();

    fireEvent.click(
      await screen.findByRole("button", { name: "第一集素材 更多操作" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "修改封面" }));

    // 只列这个文件夹自己的图片，别的文件夹的不出现。
    expect(screen.queryByRole("button", { name: "选择封面 参考图A" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择封面 女主定妆" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(updateFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "fld-1",
        { cover: "/static/c.png" },
      ),
    );
  });

  it("删除文件夹要二次确认，确认后整柜删掉", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderModal();

    const moreButton = await screen.findByRole("button", {
      name: "第一集素材 更多操作",
    });
    fireEvent.click(moreButton);
    fireEvent.click(
      within(moreButton.parentElement as HTMLElement).getByRole("button", {
        name: "删除",
      }),
    );

    // 确认文案要写明里面的素材也会没。
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("1 项素材会一起删掉");
    // 走原生 confirm 的话这个对话框根本不会出现。
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(deleteFreezoneAssetLibraryFolder).toHaveBeenCalledWith(
        "demo",
        "fld-1",
      ),
    );
  });

  it("确认文案按整柜的真实条数算，不受 allowedMedia 过滤影响", async () => {
    // 生图节点只让看图片，但后端删的是整柜——文案要照实说 2 项，不然那条视频
    // 会在用户毫不知情的情况下没掉。
    const withVideo = [
      ...FILED,
      {
        id: "up-5",
        name: "定妆花絮",
        media: "video",
        source: "upload",
        category: "character",
        folder: "fld-1",
        video_url: "/static/d.mp4",
      },
    ];
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: withVideo });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: withVideo });
    renderModal({ allowedMedia: ["image"] });

    const moreButton = await screen.findByRole("button", {
      name: "第一集素材 更多操作",
    });
    fireEvent.click(moreButton);
    fireEvent.click(
      within(moreButton.parentElement as HTMLElement).getByRole("button", {
        name: "删除",
      }),
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("2 项素材会一起删掉");
    // 一定要答完：confirmDialog 的 pending 挂在模块级 store 上，卸载组件也清不掉，
    // 漏一个没关的确认框，下一个用例一渲染就被它罩住整页。
    await dismissConfirm(dialog);
  });
});

describe("AssetLibraryModal 批量操作", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: LIBRARY });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: LIBRARY });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
    deleteFreezoneVideoCharacterLibraryItem.mockResolvedValue({ ok: true });
  });

  it("全部资产默认就是资产视图，批量删除无需先进入文件夹", async () => {
    renderModal();

    const bulkButton = await screen.findByRole("button", { name: "批量删除" });
    expect(bulkButton).toBeEnabled();
    expect(await screen.findByText("参考图A")).toBeInTheDocument();
  });

  it("管理态点击卡片进入详情并提供明确后续操作，不再产生无结果选择", async () => {
    const onSendItemToCanvas = vi.fn();
    renderModal({ onSendItemToCanvas });

    expect(screen.queryByRole("button", { name: "选择" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "查看 参考图A 详情" }),
    );

    const details = screen.getByRole("dialog", { name: "资产详情" });
    expect(within(details).getByRole("button", { name: "下载" })).toBeEnabled();
    expect(within(details).getByRole("button", { name: "删除" })).toBeEnabled();
    fireEvent.click(within(details).getByRole("button", { name: "发送到画布" }));
    expect(onSendItemToCanvas).toHaveBeenCalledWith(
      expect.objectContaining({ id: "up-1" }),
    );
  });

  it("选材态保留选择确认，但不暴露批量删除", async () => {
    renderModal({ mode: "pick", onConfirm: vi.fn() });

    expect((await screen.findAllByRole("button", { name: "选择" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "批量删除" })).toBeNull();
    expect(screen.getByRole("button", { name: "确定" })).toBeDisabled();
  });

  it("批量态下能删掉本地上传的素材，主线素材不可选", async () => {
    renderModal();
    await screen.findByRole("button", { name: "文件夹 主线" });

    fireEvent.click(screen.getByRole("button", { name: "文件夹 待分类资产" }));
    fireEvent.click(screen.getByRole("button", { name: "批量删除" }));

    fireEvent.click(await screen.findByRole("button", { name: "选中待删除" }));
    expect(screen.getByText(/只能删除本地上传的素材/)).toHaveTextContent(
      "已选 1 项",
    );

    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    await acceptDeleteConfirm();
    await waitFor(() =>
      expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "up-1",
      ),
    );
  });

  it("批量删除里有一条失败，剩下的照删", async () => {
    // 最常见的失败是这个 id 已经被别处删掉了。为它把整批放弃说不过去。
    const items = [
      {
        id: "up-1",
        name: "参考图A",
        media: "image",
        source: "upload",
        image_urls: ["/static/a.png"],
      },
      {
        id: "up-9",
        name: "参考图B",
        media: "image",
        source: "upload",
        image_urls: ["/static/e.png"],
      },
    ];
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items });
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items });
    deleteFreezoneVideoCharacterLibraryItem.mockImplementation(
      (_project: unknown, id: unknown) =>
        id === "up-1"
          ? Promise.reject(new Error("item not found"))
          : Promise.resolve({ ok: true }),
    );
    renderModal();
    await screen.findByRole("button", { name: "文件夹 主线" });

    fireEvent.click(screen.getByRole("button", { name: "文件夹 待分类资产" }));
    fireEvent.click(screen.getByRole("button", { name: "批量删除" }));

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "选中待删除" }))[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "选中待删除" }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    await acceptDeleteConfirm();

    await waitFor(() =>
      expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "up-9",
      ),
    );
    expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
      "demo",
      "up-1",
    );
  });

  it("批量态下主线素材不显示删除勾选，但仍能打开详情", async () => {
    renderModal();
    await screen.findByRole("button", { name: "文件夹 主线" });

    fireEvent.click(screen.getByRole("button", { name: "文件夹 主线" }));
    fireEvent.click(screen.getByRole("button", { name: "批量删除" }));

    expect(
      screen.queryByRole("button", { name: "主线同步来的素材不能删除" }),
    ).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "查看 厨房 详情" }));
    expect(screen.getByRole("dialog", { name: "资产详情" })).toBeInTheDocument();
    expect(screen.getByText("主线同步资产需回到对应主线内容中维护")).toBeInTheDocument();
  });
});
