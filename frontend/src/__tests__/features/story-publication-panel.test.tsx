import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";
import { StoryPublicationPanel } from "@/features/canvas/story/StoryPublicationPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  flush: vi.fn(),
  enter: vi.fn(),
  exit: vi.fn(),
  phase: "playing",
  error: null as string | null,
}));
vi.mock("@/features/canvas/story/StoryPlayer", () => ({
  StoryPlayer: () => null,
}));
vi.mock("@/stores/storyRuntimeStore", () => ({
  useStoryRuntimeStore: {
    getState: () => ({ enterPlay: mocks.enter, exitPlay: mocks.exit, phase: mocks.phase, error: mocks.error }),
  },
}));
vi.mock("@/features/canvas/story/publication", async (original) => ({
  ...(await original<typeof import("@/features/canvas/story/publication")>()),
  compilePlayback: () => ({ ink: "-> missing_publication_knot" }),
}));
vi.mock("@/api/client", () => ({ apiCall: mocks.api }));
vi.mock("@/api/canvas", () => ({
  getFreezoneCanvas: async () => ({ revision: 5 }),
}));
vi.mock("@/features/freezone/canvasSyncRuntime", () => ({
  flushFreezoneCanvasRuntime: mocks.flush,
}));
vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "p", canvas: "c" }),
}));
const work = {
  public_id: "work",
  active_version: null,
  listed: false,
  versions: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.phase = "playing";
  mocks.error = null;
  mocks.api.mockResolvedValue(work);
  mocks.flush.mockResolvedValue(true);
});
it("saves the canvas and waits for explicit preview after preparation", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/prepare")
      ? {
          ...preparedVersion,
          public_id: "work",
          version: "v1",
          status: "ready",
          issues: [],
          snapshot: { groupId: "g", nodes: [], edges: [] },
        }
      : work,
  );
  render(
    <StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />,
  );
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  await screen.findByText("storyPublication.publishThisVersion");
  expect(mocks.enter).toHaveBeenCalled();
  expect(mocks.flush).toHaveBeenCalledWith("p", "c");
  const call = mocks.api.mock.calls.find(([path]) => path.endsWith("/prepare"));
  expect(call?.[1].json).toMatchObject({
    revision: 5,
    group_id: "g",
    title: "Title",
  });
});
it("blocks preparation when the canvas cannot be saved", async () => {
  mocks.flush.mockResolvedValue(false);
  render(
    <StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />,
  );
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "storyPublication.saveFailed",
    ),
  );
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/prepare"))).toBe(
    false,
  );
});
it("shows the publication error code instead of a generic HTTP status", async () => {
  const failure = Object.assign(new Error("422 Unprocessable Entity"), {
    cause: {
      body: { detail: { code: "media_requires_local_archive" } },
    },
  });
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/prepare")) throw failure;
    return work;
  });
  render(
    <StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />,
  );
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "storyPublication.errors.media_requires_local_archive",
    ),
  );
});
it("closes the publication panel via Escape from its focused control", async () => {
  const close = vi.fn();
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={close} />);
  await waitFor(() => expect(mocks.api).toHaveBeenCalled());
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(close).toHaveBeenCalled();
});
it("does not overwrite author edits when publication metadata arrives late", async () => {
  let resolve: (data: unknown) => void = () => {};
  mocks.api.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(
    <StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />,
  );
  fireEvent.change(screen.getByLabelText("storyPublication.title"), {
    target: { value: "My new title" },
  });
  resolve({
    ...work,
    active_version: "old",
    versions: [
      { version: "old", title: "Old title", description: "Old intro" },
    ],
  });
  await waitFor(() =>
    expect(screen.getByLabelText("storyPublication.title")).toHaveValue(
      "My new title",
    ),
  );
});
it("only offers published history and restores focus when rollback is canceled", async () => {
  mocks.api.mockResolvedValue({
    ...work,
    active_version: "v2",
    listed: true,
    versions: [
      {
        version: "v2",
        title: "Live",
        description: "",
        status: "ready",
        published: true,
        number: 2,
      },
      {
        version: "v1",
        title: "Previous",
        status: "ready",
        published: true,
        number: 1,
      },
      {
        version: "pending",
        title: "Never published",
        status: "ready",
        published: false,
        number: 3,
      },
    ],
  });
  render(
    <StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />,
  );
  await screen.findByText("storyPublication.versionHistory");
  expect(screen.queryByText(/Never published/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("storyPublication.versionHistory"));
  const rollback = screen.getByRole("button", {
    name: "storyPublication.rollback",
  });
  fireEvent.click(rollback);
  fireEvent.click(
    screen.getByRole("button", { name: "storyPublication.cancel" }),
  );
  expect(rollback).toHaveFocus();
});
it("builds the sharing URL from the browser origin on the offline dashboard", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/activate")
      ? {
          ...work,
          active_version: "v2",
          listed: true,
          versions: [],
        }
      : {
          ...work,
          active_version: "v2",
          listed: false,
          versions: [
            {
              version: "v2",
              title: "Offline story",
              description: "Saved description",
              status: "ready",
              published: true,
              number: 2,
            },
          ],
        },
  );
  render(
    <StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />,
  );
  await screen.findByText("storyPublication.shareWithPlayers");
  expect(
    screen.getByRole("heading", { name: "Offline story", level: 3 }),
  ).toBeInTheDocument();
  expect(screen.getByText("Saved description")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "storyPublication.openPlay" })).toHaveAttribute("href", `${window.location.origin}/play/work`);
  const restoreButtons = screen.getAllByRole("button", {
    name: "storyPublication.restore",
  });
  fireEvent.click(restoreButtons[restoreButtons.length - 1]);
  await waitFor(() =>
    expect(
      mocks.api.mock.calls.some(
        ([path, options]) =>
          path.endsWith("/activate") && options.json.listed === true,
      ),
    ).toBe(true),
  );
});
it("moves from preview to publish and then sharing, with updates opening the editor", async () => {
  const version = {
    public_id: "work",
    version: "v1",
    status: "ready",
    title: "Title",
    description: "",
    revision: 5,
    issues: [],
    snapshot: { groupId: "g", nodes: [], edges: [] },
  };
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/prepare")
      ? version
      : path.endsWith("/activate")
        ? { ...work, active_version: "v1", listed: true, versions: [version] }
        : work,
  );
  render(
    <StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />,
  );
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  await screen.findByText("storyPublication.publishThisVersion");
  expect(mocks.enter).toHaveBeenCalled();
  fireEvent.click(screen.getByText("storyPublication.back"));
  fireEvent.click(screen.getByText("storyPublication.preview"));
  fireEvent.click(
    await screen.findByText("storyPublication.publishThisVersion"),
  );
  await screen.findByText("storyPublication.publishUpdate");
  expect(
    screen.queryByLabelText("storyPublication.title"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("storyPublication.publishUpdate"));
  expect(screen.getByLabelText("storyPublication.title")).toHaveValue("Title");
});

const preparedVersion = {
  public_id: "work", version: "v1", status: "ready", title: "Title",
  description: "", revision: 5, issues: [],
  snapshot: { groupId: "g", nodes: [], edges: [] },
};

it.each([false, true])("restores a preparing cover without overwriting title edits (%s)", async (editTitle) => {
  const cover = "/api/v1/public-stories/work/versions/v1/media/poster.png";
  const ready = { ...preparedVersion, cover };
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/versions/v1") || path.endsWith("/prepare") ? ready :
      { ...work, versions: [{ ...preparedVersion, status: "preparing" }] });
  const { container } = render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  await screen.findByRole("button", { name: "storyPublication.checking" });
  if (editTitle) fireEvent.change(screen.getByLabelText("storyPublication.title"), { target: { value: "Updated title" } });
  await screen.findByLabelText("storyPublication.changeCover", {}, { timeout: 3000 });
  expect(container.querySelector(".publication-cover-row img")).toHaveAttribute("src",
    "/api/v1/projects/p/canvases/c/stories/g/publication/work/versions/v1/media/poster.png");
  expect(screen.getByLabelText("storyPublication.title")).toHaveValue(editTitle ? "Updated title" : "Title");
  if (!editTitle) expect(screen.getByRole("button", { name: "storyPublication.preview" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("storyPublication.title"), { target: { value: "Final title" } });
  fireEvent.click(screen.getByRole("button", { name: "storyPublication.checkAndPreview" }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("/prepare"),
    expect.objectContaining({ json: expect.objectContaining({ title: "Final title", cover }) })));
});

it("keeps a newly uploaded cover when the restored job finishes", async () => {
  const cover = "/api/v1/projects/p/media/new.png";
  mocks.api.mockImplementation(async (path: string) => path.endsWith("/upload") ? { url: cover } :
    path.endsWith("/versions/v1") ? { ...preparedVersion, cover: "/api/v1/public-stories/work/versions/v1/media/old.png" } :
      { ...work, versions: [{ ...preparedVersion, status: "preparing" }] });
  const { container } = render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  await screen.findByRole("button", { name: "storyPublication.checking" });
  fireEvent.change(screen.getByLabelText("storyPublication.uploadCover"), {
    target: { files: [new File(["image"], "new.png", { type: "image/png" })] },
  });
  await screen.findByLabelText("storyPublication.changeCover");
  await waitFor(() => expect(screen.getByRole("button", { name: "storyPublication.checkAndPreview" })).toBeEnabled(), { timeout: 3000 });
  expect(container.querySelector(".publication-cover-row img")).toHaveAttribute("src", cover);
});

it("exits embedded playback when navigation unmounts the panel", async () => {
  mocks.api.mockResolvedValue({ ...work, versions: [preparedVersion] });
  const view = render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  expect(mocks.enter).toHaveBeenCalledWith(expect.anything(), { embedded: true });
  mocks.exit.mockClear();
  view.unmount();
  expect(mocks.exit).toHaveBeenCalledTimes(1);
});
it("blocks publication when the runtime catches an Ink compiler error", async () => {
  const { useStoryRuntimeStore } = await vi.importActual<
    typeof import("@/stores/storyRuntimeStore")
  >("@/stores/storyRuntimeStore");
  mocks.enter.mockImplementationOnce((compiled) => {
    useStoryRuntimeStore.getState().enterPlay(compiled);
    mocks.phase = useStoryRuntimeStore.getState().phase;
    mocks.error = useStoryRuntimeStore.getState().error;
  });
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/prepare") ? preparedVersion : work);
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/compilation failed/i));
  expect(mocks.phase).toBe("error");
  useStoryRuntimeStore.getState().exitPlay();
  expect(screen.queryByText("storyPublication.publishThisVersion")).not.toBeInTheDocument();
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/activate"))).toBe(false);
});
it("retries a lost preparation response with the identical request", async () => {
  let attempts = 0;
  mocks.api.mockImplementation(async (path: string) => {
    if (!path.endsWith("/prepare")) return work;
    if (++attempts === 1) throw new Error("Response lost");
    return preparedVersion;
  });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  await screen.findByText("Response lost");
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  await screen.findByText("storyPublication.publishThisVersion");
  const calls = mocks.api.mock.calls.filter(([path]) => path.endsWith("/prepare"));
  expect(calls).toHaveLength(2);
  expect(calls[1][1].json).toEqual(calls[0][1].json);
  expect(mocks.flush).toHaveBeenCalledTimes(1); // Neither preview nor network retry saves again.
});
it("uses a new request when the author changes a failed attempt's input", async () => {
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/prepare")) throw new Error("Response lost");
    return work;
  });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  await screen.findByText("Response lost");
  fireEvent.change(screen.getByLabelText("storyPublication.title"), { target: { value: "Updated" } });
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  await screen.findByText("Response lost");
  const calls = mocks.api.mock.calls.filter(([path]) => path.endsWith("/prepare"));
  expect(calls).toHaveLength(2);
  expect(calls[1][1].json.request_id).not.toEqual(calls[0][1].json.request_id);
});
it("restores an unpublished ready snapshot after reopening without preparing again", async () => {
  mocks.api.mockResolvedValue({ ...work, versions: [preparedVersion] });
  render(<StoryPublicationPanel groupId="g" title="Other" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("storyPublication.title")).toHaveValue("Title"));
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  await screen.findByText("storyPublication.publishThisVersion");
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/prepare"))).toBe(false);
});

it.each([false, true])("uses author media for a restored pending cover (existing publication: %s)", async (published) => {
  const pending = { ...preparedVersion,
    cover: "/api/v1/public-stories/work/versions/v1/media/poster.png" };
  mocks.api.mockResolvedValue({ ...work,
    active_version: published ? "live" : null,
    versions: [pending, ...(published ? [{ ...preparedVersion, version: "live", published: true }] : [])],
  });
  const { container } = render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  if (published) fireEvent.click(await screen.findByRole("button", { name: "storyPublication.continuePreparation" }));
  await screen.findByLabelText("storyPublication.changeCover");
  const poster = container.querySelector(".publication-cover-row img");
  expect(poster).toHaveAttribute("src", "/api/v1/projects/p/canvases/c/stories/g/publication/work/versions/v1/media/poster.png");
  fireEvent.change(screen.getByLabelText("storyPublication.coverHorizontal"), { target: { value: "25" } });
  expect(poster).toHaveStyle({ objectPosition: "25% 50%" });
});

it("restores a preparing task and polls it instead of creating another version", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/versions/v1") ? preparedVersion :
      { ...work, versions: [{ ...preparedVersion, status: "preparing", snapshot: undefined }] });
  render(<StoryPublicationPanel groupId="g" title="Other" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("storyPublication.title")).toHaveValue("Title"));
  expect(screen.getByRole("button", { name: "storyPublication.checking" })).toBeDisabled();
  const previewButton = await screen.findByRole("button", { name: "storyPublication.preview" }, { timeout: 3000 });
  expect(mocks.enter).not.toHaveBeenCalled();
  fireEvent.click(previewButton);
  await screen.findByText("storyPublication.publishThisVersion");
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/prepare"))).toBe(false);
});

it("explicitly prepares the latest canvas separately from preview", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/prepare") ? preparedVersion :
      { ...work, versions: [{ ...preparedVersion, revision: 4 }] });
  render(<StoryPublicationPanel groupId="g" title="Other" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("storyPublication.title")).toHaveValue("Title"));
  fireEvent.click(screen.getByText("storyPublication.prepareLatest"));
  await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/prepare"))).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  await screen.findByText("storyPublication.publishThisVersion");
  const call = mocks.api.mock.calls.find(([path]) => path.endsWith("/prepare"));
  expect(call?.[1].json.revision).toBe(5);
});

it("keeps the management view visible when an update is waiting", async () => {
  mocks.api.mockResolvedValue({ ...work, active_version: "live", listed: true,
    versions: [preparedVersion, { ...preparedVersion, version: "live", published: true, number: 1 }] });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  await screen.findByRole("button", { name: "storyPublication.continuePreparation" });
  expect(screen.queryByText("storyPublication.pendingUpdate")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "storyPublication.managePublication" })).toBeInTheDocument();
  expect(screen.queryByLabelText("storyPublication.title")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "storyPublication.continuePreparation" }));
  expect(screen.getByLabelText("storyPublication.title")).toHaveValue("Title");
});
it("persists portrait cover framing in the preparation request", async () => {
  mocks.api.mockImplementation(async (path: string) => path.endsWith("/upload") ? { url: "/poster.png" } : path.endsWith("/prepare") ? { ...preparedVersion, cover: "/poster.png", cover_mode: "portrait", cover_position_x: 25, cover_position_y: 75 } : work);
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "storyPublication.portrait" }));
  fireEvent.change(screen.getByLabelText("storyPublication.uploadCover"), { target: { files: [new File(["image"], "poster.png", { type: "image/png" })] } });
  await screen.findByLabelText("storyPublication.changeCover");
  fireEvent.change(screen.getByLabelText("storyPublication.coverHorizontal"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("storyPublication.coverVertical"), { target: { value: "75" } });
  fireEvent.click(screen.getByText("storyPublication.checkAndPreview"));
  await screen.findByRole("button", { name: "storyPublication.preview" });
  const call = mocks.api.mock.calls.find(([path]) => path.endsWith("/prepare"));
  expect(call?.[1].json).toMatchObject({ cover: "/poster.png", cover_mode: "portrait", cover_position_x: 25, cover_position_y: 75 });
  expect(mocks.enter).not.toHaveBeenCalled();
});
it("previewing and selecting a historical version does not relist an offline work", async () => {
  const live = { ...preparedVersion, version: "live", published: true, number: 2 };
  const old = { ...preparedVersion, version: "old", published: true, number: 1 };
  mocks.api.mockResolvedValue({ ...work, active_version: "live", versions: [live, old] });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  await screen.findByText("storyPublication.versionHistory");
  fireEvent.click(screen.getByText("storyPublication.versionHistory"));
  fireEvent.click(screen.getAllByText("storyPublication.previewVersion")[1]);
  expect(screen.queryByText("storyPublication.publishThisVersion")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("storyPublication.viewSharing"));
  fireEvent.click(screen.getByRole("button", { name: "storyPublication.rollback" }));
  fireEvent.click(screen.getAllByRole("button", { name: "storyPublication.rollback" })[1]);
  await waitFor(() => expect(mocks.api.mock.calls.some(([path, options]) =>
    path.endsWith("/activate") && options.json.version === "old" && options.json.listed === false)).toBe(true));
});

it("does not resurrect abandoned preparations after a newer publication", async () => {
  mocks.api.mockResolvedValue({ ...work, active_version: "live", listed: true,
    versions: [preparedVersion, { ...preparedVersion, version: "live", published: true, number: 2,
      published_at: "2026-09-16T06:30:00Z" }].map(v => ({ ...v, created_at: "2026-09-16T06:00:00Z" })) });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  await screen.findByRole("heading", { name: "storyPublication.managePublication" });
  expect(screen.queryByText("storyPublication.pendingUpdate")).not.toBeInTheDocument();
  expect(screen.getByText("storyPublication.publishUpdate")).toBeInTheDocument();
});

it("previews a fixed snapshot even when the canvas changed and saving is unavailable", async () => {
  mocks.api.mockResolvedValue({ ...work, versions: [{ ...preparedVersion, revision: 4 }] });
  mocks.flush.mockImplementation(() => new Promise(() => {}));
  render(<StoryPublicationPanel groupId="g" title="Other" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  await screen.findByText("storyPublication.publishThisVersion");
  expect(mocks.enter).toHaveBeenCalledTimes(1);
  expect(mocks.enter).toHaveBeenCalledWith(expect.anything(), { embedded: true });
  expect(mocks.flush).not.toHaveBeenCalled();
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/prepare"))).toBe(false);
});

it("reports missing preview data and offers preparation recovery", async () => {
  mocks.api.mockResolvedValue({ ...work, versions: [{ ...preparedVersion, snapshot: undefined }] });
  render(<StoryPublicationPanel groupId="g" title="Other" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.preview" }));
  expect(screen.getByRole("alert")).toHaveTextContent("storyPublication.previewUnavailable");
  expect(screen.getByRole("button", { name: "storyPublication.prepareLatest" })).toBeEnabled();
  expect(mocks.enter).not.toHaveBeenCalled();
  expect(screen.queryByText("storyPublication.publishThisVersion")).not.toBeInTheDocument();
});

it("keeps availability controls in the overview and history actions separate", async () => {
  mocks.api.mockResolvedValue({ ...work, active_version: "v1", listed: true,
    versions: [{ ...preparedVersion, published: true, number: 1 }] });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  const takeDown = await screen.findByRole("button", { name: "storyPublication.takeDown" });
  expect(takeDown.closest(".publication-release-overview")).not.toBeNull();
  expect(takeDown.closest("details")).toBeNull();
  expect(screen.getByText("storyPublication.previewVersion").closest(".publication-version-actions")).not.toBeNull();
  fireEvent.click(takeDown);
  expect(screen.getByRole("alertdialog", { name: "storyPublication.takeDownTitle" }).closest(".publication-overlay")).toBeNull();
  fireEvent.click(screen.getByText("storyPublication.cancel"));
  await waitFor(() => expect(screen.queryByText("storyPublication.takeDownConfirm")).not.toBeInTheDocument());
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/activate"))).toBe(false);
});


it("Escape dismisses only the take-down confirmation", async () => {
  mocks.api.mockResolvedValue({ ...work, active_version: "v1", listed: true,
    versions: [{ ...preparedVersion, published: true, number: 1 }] });
  const onClose = vi.fn();
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={onClose} />);
  const trigger = await screen.findByRole("button", { name: "storyPublication.takeDown" });
  fireEvent.click(trigger);
  const cancel = await screen.findByRole("button", { name: "storyPublication.cancel" });
  await waitFor(() => expect(cancel).toHaveFocus());
  fireEvent.keyDown(cancel, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/activate"))).toBe(false);
});

it("keeps failed take-down confirmation open for retry and closes after success", async () => {
  const online = { ...work, active_version: "v1", listed: true,
    versions: [{ ...preparedVersion, published: true, number: 1 }] };
  mocks.api.mockResolvedValueOnce(online)
    .mockRejectedValueOnce(new Error("Request failed"))
    .mockResolvedValueOnce({ ...online, listed: false });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "storyPublication.takeDown" }));
  const confirm = await screen.findByRole("button", { name: "storyPublication.confirmTakeDown" });
  fireEvent.click(confirm);
  expect(await screen.findByRole("alert")).toHaveTextContent("Request failed");
  expect(screen.getByRole("alertdialog")).toContainElement(screen.getByRole("alert"));
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "storyPublication.restore" })).toBeInTheDocument();
  expect(mocks.api).toHaveBeenLastCalledWith(expect.stringContaining("/activate"), {
    method: "POST", json: { version: null, listed: false },
  });
});

it("locates the offending choice and shows its readable label", async () => {
  const { useCanvasStore } = await import("@/stores/canvasStore");
  const previous = useCanvasStore.getState();
  useCanvasStore.setState({ nodes: [{ id: "source", type: "videoNode", position: { x: 0, y: 0 }, data: {} }],
    edges: [{ id: "choice", source: "source", target: "source", type: "storyChoiceEdge", data: {} }] });
  mocks.api.mockResolvedValue({ ...work, versions: [{ ...preparedVersion, status: "failed", error: "invalid_story",
    issues: [{ severity: "error", code: "choice_area_outside_left", entity_id: "choice", node_id: "source", entity_label: "路线选择 → 上班通勤" }] }] });
  const close = vi.fn();
  try {
    render(<StoryPublicationPanel groupId="g" title="Title" onClose={close} />);
    expect(await screen.findByText("路线选择 → 上班通勤")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "storyPublication.locateIssue" }));
    expect(close).toHaveBeenCalled();
    expect(useCanvasStore.getState().edges.find(edge => edge.id === "choice")?.selected).toBe(true);
    expect(useCanvasStore.getState().pendingFocusNodeId).toBe("source");
  } finally { useCanvasStore.setState(previous); }
});

it("routes author validation failures back to canvas checks instead of retrying preparation", async () => {
  const { useCanvasStore } = await import("@/stores/canvasStore");
  const openChecks = vi.spyOn(useCanvasStore.getState(), "openStoryLint").mockImplementation(() => {});
  const close = vi.fn();
  mocks.api.mockResolvedValue({ ...work, versions: [{ ...preparedVersion, status: "failed", error: "invalid_story" }] });
  try {
    render(<StoryPublicationPanel groupId="g" title="Title" onClose={close} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("storyPublication.errors.invalid_story");
    expect(screen.queryByText("storyPublication.retryChecks")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "storyPublication.openChecks" }));
    expect(close).toHaveBeenCalled();
    expect(openChecks).toHaveBeenCalledWith("g");
    expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/prepare"))).toBe(false);
  } finally { openChecks.mockRestore(); }
});

it("shows system failures as interrupted checks and offers retry", async () => {
  mocks.api.mockResolvedValue({ ...work, versions: [{ ...preparedVersion, status: "failed", error: "publication_check_failed" }] });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  expect(await screen.findByText("storyPublication.checkIncomplete")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("storyPublication.errors.publication_check_failed");
  expect(screen.queryByText("storyPublication.openChecks")).not.toBeInTheDocument();
  mocks.api.mockImplementation(async (path: string) => path.endsWith("/prepare") ? preparedVersion : work);
  fireEvent.click(screen.getByRole("button", { name: "storyPublication.retryChecks" }));
  await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/prepare"))).toBe(true));
});


it("switches to the new archived cover before the old draft is retired", async () => {
  const oldCover = "/api/v1/public-stories/work/versions/old/media/poster.png";
  const newCover = "/api/v1/public-stories/work/versions/v1/media/poster.png";
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/prepare") ? { ...preparedVersion, title: "Updated", status: "preparing" } :
    path.endsWith("/versions/v1") ? { ...preparedVersion, title: "Updated", cover: newCover } :
    { ...work, versions: [{ ...preparedVersion, version: "old", cover: oldCover }] });
  const { container } = render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  await screen.findByLabelText("storyPublication.changeCover");
  fireEvent.change(screen.getByLabelText("storyPublication.title"), { target: { value: "Updated" } });
  fireEvent.click(screen.getByRole("button", { name: "storyPublication.checkAndPreview" }));
  await screen.findByRole("button", { name: "storyPublication.preview" }, { timeout: 3000 });
  expect(container.querySelector(".publication-cover-row img")).toHaveAttribute("src",
    "/api/v1/projects/p/canvases/c/stories/g/publication/work/versions/v1/media/poster.png");
  fireEvent.change(screen.getByLabelText("storyPublication.title"), { target: { value: "Next" } });
  fireEvent.click(screen.getByRole("button", { name: "storyPublication.checkAndPreview" }));
  await waitFor(() => expect(mocks.api).toHaveBeenLastCalledWith(expect.stringContaining("/prepare"),
    expect.objectContaining({ json: expect.objectContaining({ cover: newCover }) })));
});


it("stops checking and explains when another window supersedes the draft", async () => {
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/versions/v1")) throw { detail: { code: "not_found" } };
    return { ...work, versions: [{ ...preparedVersion, status: "preparing" }] };
  });
  render(<StoryPublicationPanel groupId="g" title="Title" onClose={() => {}} />);
  expect(await screen.findByRole("alert", {}, { timeout: 3000 })).toHaveTextContent("storyPublication.errors.draft_superseded");
  expect(screen.queryByRole("button", { name: "storyPublication.checking" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "storyPublication.openChecks" })).not.toBeInTheDocument();
});
