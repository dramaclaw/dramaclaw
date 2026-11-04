import { beforeEach, describe, expect, it } from "vitest";
import {
  type PlaybackSnapshot,
  compilePlayback,
  playerSaveKey,
  rememberVersion,
  savedVersion,
} from "@/features/canvas/story/publication";
import { useStoryRuntimeStore } from "@/stores/storyRuntimeStore";
import { readStorySave } from "@/features/canvas/story/storySave";

const snapshot: PlaybackSnapshot = {
  groupId: "g",
  nodes: [
    { id: "g", type: "groupNode", position: { x: 0, y: 0 }, data: {} },
    {
      id: "start",
      type: "videoNode",
      parentId: "g",
      position: { x: 0, y: 0 },
      data: { storyRole: "start", videoUrl: "/published/start.mp4" },
    },
    {
      id: "end",
      type: "videoNode",
      parentId: "g",
      position: { x: 0, y: 0 },
      data: {
        endingLabel: "GE",
        narration: "Done",
        videoUrl: "/published/end.mp4",
      },
    },
  ],
  edges: [
    {
      id: "choice",
      type: "storyChoiceEdge",
      source: "start",
      target: "end",
      data: { choiceText: "Continue", order: 0 },
    },
  ],
};
beforeEach(() => {
  localStorage.clear();
  useStoryRuntimeStore.getState().exitPlay();
});
describe("published playback", () => {
  it("compiles the server snapshot and saves separately from creator previews", () => {
    const compiled = compilePlayback(snapshot);
    const key = playerSaveKey("work", "v1");
    useStoryRuntimeStore.getState().enterPlay(compiled, { saveKey: key });
    useStoryRuntimeStore.getState().choose(0);
    expect(readStorySave(key)).toBeTruthy();
    expect(readStorySave(playerSaveKey("work", "v2"))).toBeNull();
    rememberVersion("work", "v1");
    expect(savedVersion("work")).toBe("v1");
  });
  it("recovers from a corrupt published save", () => {
    const key = playerSaveKey("work", "v1");
    localStorage.setItem(key, "invalid-json");
    useStoryRuntimeStore
      .getState()
      .enterPlay(compilePlayback(snapshot), { saveKey: key });
    expect(useStoryRuntimeStore.getState().resumeSaved()).toBe(false);
    expect(useStoryRuntimeStore.getState().phase).not.toBe("error");
  });
  it("rejects a dangling published branch", () => {
    expect(() =>
      compilePlayback({
        ...snapshot,
        edges: [{ ...snapshot.edges[0], target: "missing" }],
      }),
    ).toThrow();
  });
});


it("plays both endings from a published branching snapshot", () => {
  const branches: PlaybackSnapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes, { id: "end2", type: "videoNode", parentId: "g", position: { x: 0, y: 0 }, data: { endingLabel: "BE", narration: "Other ending", videoUrl: "/published/end2.mp4" } }],
    edges: [...snapshot.edges, { id: "choice2", type: "storyChoiceEdge", source: "start", target: "end2", data: { choiceText: "Other road", order: 1 } }],
  };
  const compiled = compilePlayback(branches);
  for (const [index, expected] of [[0, "end"], [1, "end2"]] as const) {
    useStoryRuntimeStore.getState().enterPlay(compiled);
    expect(useStoryRuntimeStore.getState().currentChoices).toHaveLength(2);
    useStoryRuntimeStore.getState().choose(index);
    expect(useStoryRuntimeStore.getState().currentNodeId).toBe(expected);
  }
});
