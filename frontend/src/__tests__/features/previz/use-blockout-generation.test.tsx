// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 「从参考图生成场景」的提交侧：上传、提交、把任务句柄写到预演台节点上。等结果与
// 落地不在这里——那是画布恢复路径（resumeGeneration）的事，跟别的节点一样，关掉
// 对话框、关掉编辑器、刷新页面都不会把任务弄丢。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { nodeNeedsGenerationResume } from "@/features/canvas/application/resumeGeneration";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { PREVIZ_PRIMITIVE_LIMIT } from "@/features/previz/domain/limits";
import { createDefaultScene, type PrevizProp } from "@/features/previz/domain/scene";
import { usePrevizStore } from "@/features/previz/store";
import { useBlockoutGeneration } from "@/features/previz/ui/useBlockoutGeneration";
import { readUrl } from "@/lib/url-params";
import { useCanvasStore } from "@/stores/canvasStore";

type Upload = (project: string, file: File, name: string) => Promise<{ url: string }>;
type Submit = (
  project: string,
  payload: {
    sourceUrl: string;
    description?: string;
    pictureCheck?: boolean;
    renderCheck?: boolean;
    model?: string;
    canvasId?: string;
    nodeId?: string;
  },
) => Promise<{ task_type: string; job_id: string; task_key: string }>;
type Fetch = (project: string, jobId: string) => Promise<unknown>;

const JOB = {
  task_type: "freezone_image_to_blockout",
  job_id: "job-1",
  task_key: "freezone_image_to_blockout:job-1",
};

const uploadFreezoneImage = vi.fn<Upload>(async () => ({ url: "/static/ref.png" }));
const submitFreezoneImageToBlockout = vi.fn<Submit>(async () => JOB);
const fetchFreezoneImageToBlockoutResult = vi.fn<Fetch>(async () => result(3));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
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

function result(pieces: number, warnings: string[] = []) {
  return {
    objects: Array.from({ length: pieces }, (_, index) => piece(index)),
    reference_camera_id: null,
    counts: { prop: pieces, camera: 0 },
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

/** 一个真实的预演台节点：句柄要写到它身上，恢复路径也从它身上读。 */
function addPrevizNode(data: Record<string, unknown> = {}): string {
  const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 }, data);
  if (!id) throw new Error("could not add previz node");
  return id;
}

const nodeData = (id: string) =>
  useCanvasStore.getState().nodes.find((node) => node.id === id)?.data as Record<string, unknown>;
const node = (id: string) => useCanvasStore.getState().nodes.find((entry) => entry.id === id)!;

function setup(nodeId: string) {
  return renderHook(({ id }) => useBlockoutGeneration(id), { initialProps: { id: nodeId } });
}

const request = (mode: "replace" | "append" = "replace") => ({
  file: image(),
  description: "",
  pictureCheck: false,
  renderCheck: false,
  model: "",
  mode,
});

const objectIds = () => usePrevizStore.getState().scene.objects.map((object) => object.id);

beforeEach(() => {
  vi.clearAllMocks();
  uploadFreezoneImage.mockReset().mockImplementation(async () => ({ url: "/static/ref.png" }));
  submitFreezoneImageToBlockout.mockReset().mockImplementation(async () => JOB);
  fetchFreezoneImageToBlockoutResult.mockReset().mockImplementation(async () => result(3));
  vi.mocked(readUrl).mockReturnValue({ project: "demo", canvas: "board-1" });
  useCanvasStore.getState().setCanvasData([], []);
  usePrevizStore.getState().loadScene(createDefaultScene());
});

const upstreamOf = (id: string) => {
  const { nodes, edges } = useCanvasStore.getState();
  return edges
    .filter((edge) => edge.target === id)
    .map((edge) => nodes.find((entry) => entry.id === edge.source)!);
};

describe("useBlockoutGeneration keeps the reference image on the canvas", () => {
  it("adds an upload node upstream of the previz node holding the uploaded image", async () => {
    const id = useCanvasStore
      .getState()
      .addNode(CANVAS_NODE_TYPES.previz, { x: 1000, y: 300 }, {})!;
    const { result: hook } = setup(id);

    await act(async () => {
      await hook.current.start({ ...request(), imageSize: { width: 1920, height: 1080 } });
    });

    const [reference] = upstreamOf(id);
    expect(upstreamOf(id)).toHaveLength(1);
    expect(reference!.type).toBe(CANVAS_NODE_TYPES.upload);
    expect(reference!.data).toMatchObject({
      imageUrl: "/static/ref.png",
      aspectRatio: "16:9",
      displayName: 'previz.blockout.referenceNodeName:{"index":1}',
    });
    // 落在预演台左边，不压着它。
    expect(reference!.position.x + (reference!.width ?? 0)).toBeLessThan(1000);
    expect(reference!.position.y).toBe(300);
  });

  it("numbers a second reference and stacks it below the first", async () => {
    const id = addPrevizNode();
    const { result: hook } = setup(id);

    await act(async () => {
      await hook.current.start(request());
    });
    act(() => useCanvasStore.getState().updateNodeData(id, { isGenerating: false }));
    await act(async () => {
      await hook.current.start(request());
    });

    const [first, second] = upstreamOf(id);
    expect(upstreamOf(id)).toHaveLength(2);
    expect(second!.data.displayName).toBe('previz.blockout.referenceNodeName:{"index":2}');
    expect(second!.position.y).toBeGreaterThanOrEqual(first!.position.y + (first!.height ?? 0));
  });

  it("leaves the canvas alone when the task was never submitted", async () => {
    submitFreezoneImageToBlockout.mockRejectedValueOnce(new Error("no model"));
    const id = addPrevizNode();
    const { result: hook } = setup(id);

    await act(async () => {
      await hook.current.start(request());
    });

    expect(upstreamOf(id)).toEqual([]);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });
});

describe("useBlockoutGeneration submits and hands the task to the canvas", () => {
  it("uploads, submits and records the task on the node like any other generation", async () => {
    const id = addPrevizNode();
    const { result: hook } = setup(id);

    let queued = false;
    await act(async () => {
      queued = await hook.current.start({
        file: image(),
        description: "  门宽 0.9 米  ",
        pictureCheck: true,
        renderCheck: true,
        model: "GPT-6-Astra",
        mode: "append",
      });
    });

    expect(queued).toBe(true);
    const [project, , filename] = uploadFreezoneImage.mock.calls[0]!;
    expect(project).toBe("demo");
    expect(filename).toMatch(new RegExp(`^previz-blockout-${id}-\\d+\\.png$`));
    expect(submitFreezoneImageToBlockout).toHaveBeenCalledWith("demo", {
      sourceUrl: "/static/ref.png",
      description: "门宽 0.9 米",
      pictureCheck: true,
      renderCheck: true,
      model: "GPT-6-Astra",
      canvasId: "board-1",
      nodeId: id,
    });
    expect(nodeData(id)).toMatchObject({
      isGenerating: true,
      generationTaskKey: JOB.task_key,
      generationTaskType: "freezone_image_to_blockout",
      generationTaskJobId: "job-1",
      blockoutImportMode: "append",
      blockoutHeld: null,
    });
    expect(typeof nodeData(id).generationStartedAt).toBe("number");
    // 不等结果：落地归画布的恢复路径，所以这个任务不能算「本会话已接管」。
    expect(nodeNeedsGenerationResume(node(id))).toBe(true);
    expect(fetchFreezoneImageToBlockoutResult).not.toHaveBeenCalled();
    expect(objectIds()).toEqual([]);
    expect(toast.info).toHaveBeenCalledWith("previz.blockout.queued");
    expect(hook.current.stage).toBe("generating");
  });

  it("leaves the model to the server when the dialog kept the default", async () => {
    const id = addPrevizNode();
    const { result: hook } = setup(id);

    await act(() => hook.current.start(request()));

    expect(submitFreezoneImageToBlockout.mock.calls[0]![1]).not.toHaveProperty("model");
  });

  it("falls back to the default canvas when the URL names none", async () => {
    vi.mocked(readUrl).mockReturnValue({ project: "demo", canvas: null });
    const { result: hook } = setup(addPrevizNode());

    await act(() => hook.current.start(request()));

    expect(submitFreezoneImageToBlockout.mock.calls[0]![1]).toMatchObject({
      canvasId: "default",
      description: "",
    });
  });

  it("keeps the extension of the picked file in the upload name", async () => {
    const { result: hook } = setup(addPrevizNode());

    await act(() => hook.current.start({ ...request(), file: image("Room.JPEG") }));

    expect(uploadFreezoneImage.mock.calls[0]![2]).toMatch(/\.jpeg$/);
  });

  it("shows uploading until the task is queued, then generating until the node settles", async () => {
    const upload = deferred<{ url: string }>();
    uploadFreezoneImage.mockImplementationOnce(() => upload.promise);
    const id = addPrevizNode();
    const { result: hook } = setup(id);

    let run!: Promise<boolean>;
    act(() => {
      run = hook.current.start(request());
    });
    await waitFor(() => expect(hook.current.stage).toBe("uploading"));

    await act(async () => {
      upload.resolve({ url: "/static/ref.png" });
      await run;
    });
    expect(hook.current.stage).toBe("generating");

    // 恢复路径落地时清掉生成态（CLEARED_TASK_FIELDS），进度随之归零。
    act(() => {
      useCanvasStore.getState().updateNodeData(id, {
        isGenerating: false,
        generationTaskKey: null,
        generationTaskType: null,
        generationTaskJobId: null,
      });
    });
    expect(hook.current.stage).toBe("idle");
  });

  it("reads the generating state of a node restored from storage", () => {
    const id = addPrevizNode({
      isGenerating: true,
      generationTaskKey: JOB.task_key,
      generationTaskType: "freezone_image_to_blockout",
      generationTaskJobId: "job-1",
    });

    const { result: hook } = setup(id);

    expect(hook.current.stage).toBe("generating");
  });

  it("refuses a second start while the node is still generating", async () => {
    const id = addPrevizNode();
    const { result: hook } = setup(id);
    await act(() => hook.current.start(request()));

    let queued = true;
    await act(async () => {
      queued = await hook.current.start(request());
    });

    expect(queued).toBe(false);
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
  });
});

describe("useBlockoutGeneration refuses before spending anything", () => {
  it.each([
    ["room.gif", 2048, "previz.blockout.badExtension"],
    ["room.png", 21 * 1024 * 1024, "previz.blockout.tooLarge"],
  ])("turns away %s (%d bytes)", async (name, bytes, message) => {
    const { result: hook } = setup(addPrevizNode());

    let queued = true;
    await act(async () => {
      queued = await hook.current.start({ ...request(), file: image(name, bytes) });
    });

    expect(queued).toBe(false);
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it("needs a project in the URL", async () => {
    vi.mocked(readUrl).mockReturnValue({ project: null, canvas: null });
    const { result: hook } = setup(addPrevizNode());

    await act(() => hook.current.start(request()));

    expect(toast.error).toHaveBeenCalledWith("previz.blockout.noProject");
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it("does not start when the scene has no room for a single primitive", async () => {
    const scene = createDefaultScene();
    usePrevizStore
      .getState()
      .loadScene({ ...scene, objects: handPlacedPrimitives(PREVIZ_PRIMITIVE_LIMIT) });
    const { result: hook } = setup(addPrevizNode());

    await act(() => hook.current.start(request()));

    expect(toast.error).toHaveBeenCalledWith('previz.blockout.noRoom:{"limit":150}');
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(submitFreezoneImageToBlockout).not.toHaveBeenCalled();
  });

  it("starts on a full scene when replacing would free the slots", async () => {
    const scene = createDefaultScene();
    const blockout = handPlacedPrimitives(PREVIZ_PRIMITIVE_LIMIT).map((prop) => ({
      ...prop,
      blockout: { id: prop.id, semanticType: "prop" },
    }));
    usePrevizStore.getState().loadScene({ ...scene, objects: blockout });
    const { result: hook } = setup(addPrevizNode());

    await act(() => hook.current.start(request("replace")));

    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
  });

  it("does not start appending to a full scene", async () => {
    const scene = createDefaultScene();
    const blockout = handPlacedPrimitives(PREVIZ_PRIMITIVE_LIMIT).map((prop) => ({
      ...prop,
      blockout: { id: prop.id, semanticType: "prop" },
    }));
    usePrevizStore.getState().loadScene({ ...scene, objects: blockout });
    const { result: hook } = setup(addPrevizNode());

    await act(() => hook.current.start(request("append")));

    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.noRoom:{"limit":150}');
  });
});

describe("useBlockoutGeneration failures before the task exists leave the node alone", () => {
  async function failing(arrange: () => void) {
    arrange();
    const id = addPrevizNode();
    const before = nodeData(id);
    const { result: hook } = setup(id);
    let queued = true;
    await act(async () => {
      queued = await hook.current.start(request());
    });
    expect(queued).toBe(false);
    expect(nodeData(id)).toEqual(before);
    expect(hook.current.stage).toBe("idle");
    expect(toast.info).not.toHaveBeenCalled();
  }

  it("upload fails", async () => {
    await failing(() => uploadFreezoneImage.mockRejectedValueOnce(new Error("413")));
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.failed:{"message":"413"}');
    expect(submitFreezoneImageToBlockout).not.toHaveBeenCalled();
  });

  it("shows the message a person can read when the upload error wraps one", async () => {
    const wrapped = new Error("Request failed with status 413");
    (wrapped as { cause?: unknown }).cause = new Error("文件太大");
    await failing(() => uploadFreezoneImage.mockRejectedValueOnce(wrapped));
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.failed:{"message":"文件太大"}');
  });

  it("submit fails", async () => {
    await failing(() => submitFreezoneImageToBlockout.mockRejectedValueOnce(new Error("402")));
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.failed:{"message":"402"}');
  });
});

describe("useBlockoutGeneration keeps a paid result that did not fit", () => {
  const held = {
    jobId: "job-1",
    rejection: { reason: "primitive-limit", missing: 5, limit: PREVIZ_PRIMITIVE_LIMIT },
  };

  it("shows what the landing held on the node", () => {
    const { result: hook } = setup(addPrevizNode({ blockoutHeld: held }));

    expect(hook.current.held).toEqual(held);
  });

  it("imports the held result again by job id, without another model call", async () => {
    const id = addPrevizNode({ blockoutHeld: held });
    usePrevizStore.getState().loadScene(createDefaultScene(), id);
    const { result: hook } = setup(id);

    let imported = false;
    await act(async () => {
      imported = await hook.current.retryImport("append");
    });

    expect(imported).toBe(true);
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
    expect(submitFreezoneImageToBlockout).not.toHaveBeenCalled();
    expect(fetchFreezoneImageToBlockoutResult).toHaveBeenCalledWith("demo", "job-1");
    expect(objectIds()).toEqual(["blockout-box_0", "blockout-box_1", "blockout-box_2"]);
    expect(nodeData(id).blockoutHeld).toBeNull();
    expect(hook.current.held).toBeNull();
  });

  it("imports a held result only once when asked twice before the first fetch returns", async () => {
    const fetch = deferred<unknown>();
    fetchFreezoneImageToBlockoutResult.mockImplementationOnce(() => fetch.promise);
    const id = addPrevizNode({ blockoutHeld: held });
    usePrevizStore.getState().loadScene(createDefaultScene(), id);
    const { result: hook } = setup(id);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = hook.current.retryImport("append");
      second = hook.current.retryImport("append");
    });
    await waitFor(() => expect(hook.current.stage).toBe("importing"));

    let outcome: boolean[] = [];
    await act(async () => {
      fetch.resolve(result(3));
      outcome = await Promise.all([first, second]);
    });

    expect(outcome).toEqual([true, false]);
    expect(fetchFreezoneImageToBlockoutResult).toHaveBeenCalledTimes(1);
    expect(objectIds()).toEqual(["blockout-box_0", "blockout-box_1", "blockout-box_2"]);
    expect(hook.current.stage).toBe("idle");
  });

  it("drops the fetched result when the hold was cleared meanwhile", async () => {
    const fetch = deferred<unknown>();
    fetchFreezoneImageToBlockoutResult.mockImplementationOnce(() => fetch.promise);
    const id = addPrevizNode({ blockoutHeld: held });
    usePrevizStore.getState().loadScene(createDefaultScene(), id);
    const { result: hook } = setup(id);

    let run!: Promise<boolean>;
    act(() => {
      run = hook.current.retryImport("append");
    });
    act(() => {
      useCanvasStore.getState().updateNodeData(id, { blockoutHeld: null });
    });
    let imported = true;
    await act(async () => {
      fetch.resolve(result(3));
      imported = await run;
    });

    expect(imported).toBe(false);
    expect(objectIds()).toEqual([]);
    expect(hook.current.stage).toBe("idle");
  });

  it("keeps holding when the retry still does not fit", async () => {
    const id = addPrevizNode({ blockoutHeld: held });
    const scene = createDefaultScene();
    usePrevizStore
      .getState()
      .loadScene({ ...scene, objects: handPlacedPrimitives(PREVIZ_PRIMITIVE_LIMIT - 1) }, id);
    const { result: hook } = setup(id);

    let imported = true;
    await act(async () => {
      imported = await hook.current.retryImport("append");
    });

    expect(imported).toBe(false);
    expect(hook.current.held).toEqual({
      jobId: "job-1",
      rejection: { reason: "primitive-limit", missing: 2, limit: PREVIZ_PRIMITIVE_LIMIT },
    });
  });

  it("reports when the held result can no longer be fetched", async () => {
    fetchFreezoneImageToBlockoutResult.mockRejectedValueOnce(new Error("gone"));
    const { result: hook } = setup(addPrevizNode({ blockoutHeld: held }));

    let imported = true;
    await act(async () => {
      imported = await hook.current.retryImport("append");
    });

    expect(imported).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('previz.blockout.failed:{"message":"gone"}');
    expect(hook.current.held).toEqual(held);
  });

  it("does nothing when there is no held result", async () => {
    const { result: hook } = setup(addPrevizNode());

    let imported = true;
    await act(async () => {
      imported = await hook.current.retryImport("append");
    });

    expect(imported).toBe(false);
    expect(fetchFreezoneImageToBlockoutResult).not.toHaveBeenCalled();
  });
});
