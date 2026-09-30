// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { TaskCompletionError, TaskPollTimeoutError } from "@/api/tasks";
import { PREVIZ_PRIMITIVE_LIMIT } from "@/features/previz/domain/limits";
import { createDefaultScene, type PrevizProp } from "@/features/previz/domain/scene";
import { usePrevizStore } from "@/features/previz/store";
import { useBlockoutGeneration } from "@/features/previz/ui/useBlockoutGeneration";
import { readUrl } from "@/lib/url-params";

type Upload = (project: string, file: File, name: string) => Promise<{ url: string }>;
type Submit = (
  project: string,
  payload: {
    sourceUrl: string;
    description?: string;
    pictureCheck?: boolean;
    canvasId?: string;
    nodeId?: string;
  },
) => Promise<{ task_type: string; job_id: string; task_key: string }>;
type Await = (
  taskKey: string,
  project: string,
  options?: { taskType?: string | null },
) => Promise<unknown>;
type Fetch = (project: string, jobId: string) => Promise<unknown>;

const JOB = {
  task_type: "freezone_image_to_blockout",
  job_id: "job-1",
  task_key: "freezone_image_to_blockout:job-1",
};

const uploadFreezoneImage = vi.fn<Upload>(async () => ({ url: "/static/ref.png" }));
const submitFreezoneImageToBlockout = vi.fn<Submit>(async () => JOB);
const awaitTaskCompletion = vi.fn<Await>(async () => ({ status: "completed" }));
const fetchFreezoneImageToBlockoutResult = vi.fn<Fetch>(async () => result(3));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/url-params", () => ({
  readUrl: vi.fn(() => ({ project: "demo", canvas: "board-1" })),
}));
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: (...args: unknown[]) => uploadFreezoneImage(...(args as Parameters<Upload>)),
  submitFreezoneImageToBlockout: (...args: unknown[]) =>
    submitFreezoneImageToBlockout(...(args as Parameters<Submit>)),
  fetchFreezoneImageToBlockoutResult: (...args: unknown[]) =>
    fetchFreezoneImageToBlockoutResult(...(args as Parameters<Fetch>)),
}));
// 只换掉等待那一个函数：两个错误类要用真的，hook 是拿 instanceof 认它们的。
vi.mock("@/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/tasks")>()),
  awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...(args as Parameters<Await>)),
}));

function piece(index: number): Record<string, unknown> {
  return {
    id: `blockout-box_${index}`,
    kind: "prop",
    name: `box_${index}`,
    visible: true,
    locked: false,
    transform: { position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    assetUrl: "cube",
    assetFormat: "primitive",
    blockout: { id: `box_${index}`, semanticType: "prop" },
  };
}

function camera(): Record<string, unknown> {
  return {
    id: "blockout-cam",
    kind: "camera",
    name: "cam",
    visible: true,
    locked: false,
    transform: { position: [0, 1.6, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalMm: 28,
    aperture: 2.8,
    sensor: "ff",
    cameraBody: "cine",
    lensSeries: "prime",
    blockout: { id: "cam", semanticType: "reference_camera" },
  };
}

function result(pieces: number, warnings: string[] = []) {
  return {
    objects: [...Array.from({ length: pieces }, (_, index) => piece(index)), camera()],
    reference_camera_id: "blockout-cam",
    counts: { prop: pieces, camera: 1 },
    warnings,
    compiler_version: 1,
  };
}

function image(name = "room.png", bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function handPlacedPrimitives(count: number): PrevizProp[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `hand-${index}`,
    kind: "prop",
    name: `hand ${index}`,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    assetUrl: "cube",
    assetFormat: "primitive",
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setup(nodeId = "previz-1") {
  return renderHook(({ id }) => useBlockoutGeneration(id), { initialProps: { id: nodeId } });
}

const objectIds = () => usePrevizStore.getState().scene.objects.map((object) => object.id);

beforeEach(() => {
  vi.clearAllMocks();
  uploadFreezoneImage.mockReset().mockImplementation(async () => ({ url: "/static/ref.png" }));
  submitFreezoneImageToBlockout.mockReset().mockImplementation(async () => JOB);
  awaitTaskCompletion.mockReset().mockImplementation(async () => ({ status: "completed" }));
  fetchFreezoneImageToBlockoutResult.mockReset().mockImplementation(async () => result(3));
  vi.mocked(readUrl).mockReturnValue({ project: "demo", canvas: "board-1" });
  usePrevizStore.getState().loadScene(createDefaultScene());
});

describe("useBlockoutGeneration happy path", () => {
  it("uploads, submits, waits, fetches and imports in one undo step", async () => {
    const { result: hook } = setup();

    let imported = false;
    await act(async () => {
      imported = await hook.current.start({
        file: image(),
        description: "  门宽 0.9 米  ",
        pictureCheck: true,
        mode: "replace",
      });
    });

    expect(imported).toBe(true);
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    const [project, , filename] = uploadFreezoneImage.mock.calls[0]!;
    expect(project).toBe("demo");
    expect(filename).toMatch(/^previz-blockout-previz-1-\d+\.png$/);
    expect(submitFreezoneImageToBlockout).toHaveBeenCalledWith("demo", {
      sourceUrl: "/static/ref.png",
      description: "门宽 0.9 米",
      pictureCheck: true,
      canvasId: "board-1",
      nodeId: "previz-1",
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith(JOB.task_key, "demo", {
      taskType: "freezone_image_to_blockout",
    });
    expect(fetchFreezoneImageToBlockoutResult).toHaveBeenCalledWith("demo", "job-1");

    expect(objectIds()).toEqual([
      "blockout-box_0",
      "blockout-box_1",
      "blockout-box_2",
      "blockout-cam",
    ]);
    expect(usePrevizStore.getState().past).toHaveLength(1);
    expect(usePrevizStore.getState().activeCameraId).toBe("blockout-cam");
    expect(toast.success).toHaveBeenCalledWith('previz.blockout.done:{"count":3}');
    expect(toast.warning).not.toHaveBeenCalled();
    expect(hook.current.stage).toBe("idle");
    expect(hook.current.held).toBeNull();
  });

  it("falls back to the default canvas when the URL names none", async () => {
    vi.mocked(readUrl).mockReturnValue({ project: "demo", canvas: null });
    const { result: hook } = setup();

    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    expect(submitFreezoneImageToBlockout.mock.calls[0]![1]).toMatchObject({
      canvasId: "default",
      description: "",
    });
  });

  it("keeps the extension of the picked file in the upload name", async () => {
    const { result: hook } = setup();

    await act(() =>
      hook.current.start({ file: image("Room.JPEG"), description: "", pictureCheck: false, mode: "replace" }),
    );

    expect(uploadFreezoneImage.mock.calls[0]![2]).toMatch(/\.jpeg$/);
  });

  it("walks through uploading and generating while the work is in flight", async () => {
    const upload = deferred<{ url: string }>();
    const task = deferred<unknown>();
    uploadFreezoneImage.mockImplementationOnce(() => upload.promise);
    awaitTaskCompletion.mockImplementationOnce(() => task.promise);
    const { result: hook } = setup();

    let run!: Promise<boolean>;
    act(() => {
      run = hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });
    await waitFor(() => expect(hook.current.stage).toBe("uploading"));

    await act(async () => upload.resolve({ url: "/static/ref.png" }));
    await waitFor(() => expect(hook.current.stage).toBe("generating"));
    expect(objectIds()).toEqual([]);

    await act(async () => {
      task.resolve({ status: "completed" });
      await run;
    });
    expect(hook.current.stage).toBe("idle");
    expect(objectIds()).toHaveLength(4);
  });

  it("reports what the checks flagged, three lines at most", async () => {
    fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(
      result(2, ["a 悬空", "b 穿插", "c 出界", "d 太大"]),
    );
    const { result: hook } = setup();

    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    expect(toast.warning).toHaveBeenCalledWith('previz.blockout.warnings:{"count":4}', {
      description: "a 悬空\nb 穿插\nc 出界",
    });
  });
});

describe("useBlockoutGeneration refuses before spending anything", () => {
  it.each([
    ["room.gif", 2048, "previz.blockout.badExtension"],
    ["room.png", 21 * 1024 * 1024, "previz.blockout.tooLarge"],
  ])("turns away %s (%d bytes)", async (name, bytes, message) => {
    const { result: hook } = setup();

    let imported = true;
    await act(async () => {
      imported = await hook.current.start({
        file: image(name, bytes),
        description: "",
        pictureCheck: false,
        mode: "replace",
      });
    });

    expect(imported).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it("needs a project in the URL", async () => {
    vi.mocked(readUrl).mockReturnValue({ project: null, canvas: null });
    const { result: hook } = setup();

    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    expect(toast.error).toHaveBeenCalledWith("previz.blockout.noProject");
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it("does not start when the scene has no room for a single primitive", async () => {
    const scene = createDefaultScene();
    usePrevizStore
      .getState()
      .loadScene({ ...scene, objects: handPlacedPrimitives(PREVIZ_PRIMITIVE_LIMIT) });
    const { result: hook } = setup();

    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    expect(toast.error).toHaveBeenCalledWith('previz.blockout.noRoom:{"limit":150}');
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(submitFreezoneImageToBlockout).not.toHaveBeenCalled();
  });

  it("starts on a full scene when replacing would free the slots", async () => {
    const { result: hook } = setup();
    fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(result(PREVIZ_PRIMITIVE_LIMIT));
    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));
    expect(objectIds()).toHaveLength(PREVIZ_PRIMITIVE_LIMIT + 1);

    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    expect(uploadFreezoneImage).toHaveBeenCalledTimes(2);
    expect(objectIds()).toEqual([
      "blockout-box_0",
      "blockout-box_1",
      "blockout-box_2",
      "blockout-cam",
    ]);
  });

  it("does not start appending to a full scene", async () => {
    const { result: hook } = setup();
    fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(result(PREVIZ_PRIMITIVE_LIMIT));
    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "append" }));

    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.noRoom:{"limit":150}');
  });
});

describe("useBlockoutGeneration failures leave the scene alone", () => {
  async function failing(arrange: () => void) {
    arrange();
    const before = usePrevizStore.getState().scene;
    const { result: hook } = setup();
    let imported = true;
    await act(async () => {
      imported = await hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });
    expect(imported).toBe(false);
    expect(usePrevizStore.getState().scene).toBe(before);
    expect(usePrevizStore.getState().past).toHaveLength(0);
    expect(hook.current.stage).toBe("idle");
    expect(hook.current.held).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
  }

  it("upload fails", async () => {
    await failing(() => uploadFreezoneImage.mockRejectedValueOnce(new Error("disk full")));
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.failed:{"message":"disk full"}');
    expect(submitFreezoneImageToBlockout).not.toHaveBeenCalled();
  });

  it("shows the message a person can read when the upload error wraps one", async () => {
    await failing(() =>
      uploadFreezoneImage.mockRejectedValueOnce(
        Object.assign(new Error("Request failed: http://api.internal/upload"), {
          cause: new Error("文件太大"),
        }),
      ),
    );
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.failed:{"message":"文件太大"}');
  });

  it("submit fails", async () => {
    await failing(() =>
      submitFreezoneImageToBlockout.mockRejectedValueOnce(new Error("积分不足")),
    );
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.failed:{"message":"积分不足"}');
    expect(awaitTaskCompletion).not.toHaveBeenCalled();
  });

  it("the task fails", async () => {
    await failing(() =>
      awaitTaskCompletion.mockRejectedValueOnce(
        new TaskCompletionError("场景过于复杂：编译出 180 件", "failed", JOB.task_key),
      ),
    );
    expect(toast.error).toHaveBeenCalledWith(
      'previz.blockout.failed:{"message":"场景过于复杂：编译出 180 件"}',
    );
    expect(fetchFreezoneImageToBlockoutResult).not.toHaveBeenCalled();
  });

  it("the task is cancelled, which is not an error", async () => {
    await failing(() =>
      awaitTaskCompletion.mockRejectedValueOnce(
        new TaskCompletionError("cancelled", "cancelled", JOB.task_key),
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("previz.blockout.cancelled");
  });

  it("the page loses track of the task", async () => {
    await failing(() =>
      awaitTaskCompletion.mockRejectedValueOnce(new TaskPollTimeoutError(JOB.task_key, 1000)),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith("previz.blockout.detached");
  });

  it("the result cannot be read", async () => {
    await failing(() =>
      fetchFreezoneImageToBlockoutResult.mockRejectedValueOnce(new Error("job result missing")),
    );
    expect(toast.error).toHaveBeenCalledWith(
      'previz.blockout.failed:{"message":"job result missing"}',
    );
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["objects is not a list", { objects: "x", reference_camera_id: null, warnings: [] }],
    ["nothing usable in the list", { objects: [{ id: "x" }], reference_camera_id: null }],
  ])("the result is malformed: %s", async (_label, body) => {
    await failing(() => fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(body));
    expect(toast.error).toHaveBeenCalledWith("previz.blockout.rejected.empty");
  });
});

describe("useBlockoutGeneration keeps a paid result that did not fit", () => {
  function fillScene(count: number) {
    const scene = createDefaultScene();
    usePrevizStore.getState().loadScene({ ...scene, objects: handPlacedPrimitives(count) });
  }

  it("holds the result and says how many slots are missing", async () => {
    fillScene(140);
    fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(result(15));
    const before = usePrevizStore.getState().scene;
    const { result: hook } = setup();

    let imported = true;
    await act(async () => {
      imported = await hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });

    expect(imported).toBe(false);
    expect(usePrevizStore.getState().scene).toBe(before);
    expect(hook.current.held?.rejection).toEqual({
      reason: "primitive-limit",
      missing: 5,
      limit: 150,
    });
    expect(toast.error).toHaveBeenCalledWith(
      'previz.blockout.rejected.primitiveLimit:{"missing":5,"limit":150}',
    );
  });

  it("imports the held result without another model call once there is room", async () => {
    fillScene(140);
    fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(result(15, ["a 悬空"]));
    const { result: hook } = setup();
    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));
    vi.clearAllMocks();

    const scene = usePrevizStore.getState().scene;
    act(() =>
      usePrevizStore.getState().loadScene({ ...scene, objects: scene.objects.slice(0, 100) }),
    );
    let imported = false;
    act(() => {
      imported = hook.current.retryImport("append");
    });

    expect(imported).toBe(true);
    expect(objectIds()).toHaveLength(100 + 16);
    expect(hook.current.held).toBeNull();
    expect(submitFreezoneImageToBlockout).not.toHaveBeenCalled();
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('previz.blockout.done:{"count":15}');
    expect(toast.warning).toHaveBeenCalledWith('previz.blockout.warnings:{"count":1}', {
      description: "a 悬空",
    });
  });

  it("keeps holding when the retry still does not fit", async () => {
    fillScene(140);
    fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(result(15));
    const { result: hook } = setup();
    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    let imported = true;
    act(() => {
      imported = hook.current.retryImport("append");
    });

    expect(imported).toBe(false);
    expect(hook.current.held).not.toBeNull();
    expect(objectIds()).toHaveLength(140);
  });

  it("does nothing when there is no held result", () => {
    const { result: hook } = setup();

    let imported = true;
    act(() => {
      imported = hook.current.retryImport("replace");
    });

    expect(imported).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("lets go of the held result when abandoned", async () => {
    fillScene(140);
    fetchFreezoneImageToBlockoutResult.mockResolvedValueOnce(result(15));
    const { result: hook } = setup();
    await act(() => hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" }));

    act(() => hook.current.abandon());

    expect(hook.current.held).toBeNull();
  });
});

describe("useBlockoutGeneration drops results nobody is waiting for", () => {
  it("does not import after the dialog was closed mid-generation", async () => {
    const task = deferred<unknown>();
    awaitTaskCompletion.mockImplementationOnce(() => task.promise);
    const { result: hook } = setup();
    let run!: Promise<boolean>;
    act(() => {
      run = hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });
    await waitFor(() => expect(hook.current.stage).toBe("generating"));

    act(() => hook.current.abandon());
    expect(hook.current.stage).toBe("idle");
    let imported = true;
    await act(async () => {
      task.resolve({ status: "completed" });
      imported = await run;
    });

    expect(imported).toBe(false);
    expect(objectIds()).toEqual([]);
    expect(fetchFreezoneImageToBlockoutResult).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("stays quiet when an abandoned run fails later", async () => {
    const task = deferred<unknown>();
    awaitTaskCompletion.mockImplementationOnce(() => task.promise);
    const { result: hook } = setup();
    let run!: Promise<boolean>;
    act(() => {
      run = hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });
    await waitFor(() => expect(hook.current.stage).toBe("generating"));
    act(() => hook.current.abandon());

    await act(async () => {
      task.reject(new TaskCompletionError("boom", "failed", JOB.task_key));
      await run;
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  // store 是模块级单例：编辑器关掉之后再打开的可能是另一个预演台节点，迟到的结果
  // 要是照样导入，白模就落进了别人的场景里。
  it("does not import into whatever scene is loaded after the editor unmounted", async () => {
    const task = deferred<unknown>();
    awaitTaskCompletion.mockImplementationOnce(() => task.promise);
    const { result: hook, unmount } = setup();
    let run!: Promise<boolean>;
    act(() => {
      run = hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });
    await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalled());

    unmount();
    usePrevizStore.getState().loadScene(createDefaultScene());
    await act(async () => {
      task.resolve({ status: "completed" });
      await run;
    });

    expect(objectIds()).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not import after the editor switched to another node", async () => {
    const task = deferred<unknown>();
    awaitTaskCompletion.mockImplementationOnce(() => task.promise);
    const { result: hook, rerender } = setup("previz-1");
    let run!: Promise<boolean>;
    act(() => {
      run = hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });
    await waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalled());

    rerender({ id: "previz-2" });
    await act(async () => {
      task.resolve({ status: "completed" });
      await run;
    });

    expect(objectIds()).toEqual([]);
    expect(hook.current.stage).toBe("idle");
  });

  it("refuses a second start while one is running", async () => {
    const task = deferred<unknown>();
    awaitTaskCompletion.mockImplementationOnce(() => task.promise);
    const { result: hook } = setup();
    let first!: Promise<boolean>;
    act(() => {
      first = hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });
    await waitFor(() => expect(hook.current.stage).toBe("generating"));

    let second = true;
    await act(async () => {
      second = await hook.current.start({ file: image(), description: "", pictureCheck: false, mode: "replace" });
    });

    expect(second).toBe(false);
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    await act(async () => {
      task.resolve({ status: "completed" });
      await first;
    });
    expect(objectIds()).toHaveLength(4);
  });
});
