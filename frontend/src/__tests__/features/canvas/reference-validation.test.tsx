import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReferenceValidationDialog, referenceDurationIssues, referenceIssues, matchesReference, referenceIssueName } from "@/features/canvas/nodes/shared/ReferenceValidationDialog";
import { readReferenceMediaLimits } from "@/api/referenceMediaLimits";
import { audioReferenceDurationRejection } from "@/features/canvas/nodes/shared/videoModelCapabilities";

const focus = vi.hoisted(() => vi.fn());
const select = vi.hoisted(() => vi.fn());
vi.mock("@/stores/canvasStore", () => ({ useCanvasStore: { getState: () => ({
  nodes: [{ id: "source" }], requestFocusNode: focus, setSelectedNode: select,
}) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) =>
  `${key}${values ? ` ${values.actual} ${values.expected}` : ""}` }) }));

describe("reference media errors", () => {
  it("preserves optional limits without adding model-specific defaults", () => {
    expect(readReferenceMediaLimits({})).toEqual({});
    expect(readReferenceMediaLimits({ referenceImageMinWidth: null, referenceAudioFormats: [], referenceVideoMaxFPS: 60 }))
      .toEqual({ referenceImageMinWidth: null, referenceAudioFormats: [], referenceVideoMaxFPS: 60 });
    expect(readReferenceMediaLimits({ referenceImageMinWidth: -1, referenceVideoMaxFPS: Infinity })).toEqual({});
  });
  it("decodes only the structured validation contract", () => {
    const issue = { media: "image", index: 2, name: "portrait.png", reference_key: "freezone/portrait.png", code: "minWidth", actual: 299, expected: 300 };
    expect(referenceIssues({ body: { detail: { code: "REFERENCE_MEDIA_INVALID", errors: [issue] } } })).toEqual([issue]);
    expect(referenceIssues(new Error("other"))).toEqual([]);
  });
  it("matches decoded relative media paths without basename ambiguity", () => {
    expect(matchesReference("/api/v1/projects/p/media/freezone/%E5%9B%BE.png", "freezone/图.png")).toBe(true);
    expect(matchesReference("/media/other/图.png", "freezone/图.png")).toBe(false);
    expect(matchesReference("/media/x.png?secret=yes", "")).toBe(false);
  });
  it("prefers the uploaded filename over a generic canvas node title", () => {
    const issue = { media: "video", index: 1, name: "stored-123.mkv", reference_key: "stored-123.mkv", code: "format" };
    expect(referenceIssueName(issue, "bad_video_format.mkv")).toBe("bad_video_format.mkv");
    expect(referenceIssueName(issue, " ")).toBe("stored-123.mkv");
  });
  it("locates short audio clips through the same reference dialog", () => {
    const rejection = audioReferenceDurationRejection([
      { label: "bad_audio_duration_mp3_1s.mp3", durationMs: 1000, nodeId: "source", url: "/audio/one", index: 2 },
    ], { minMs: 2000, maxMs: 30000 });
    expect(rejection?.kind).toBe("tooShort");
    if (!rejection) return;
    const issues = referenceDurationIssues("audio", rejection, { minMs: 2000 });
    expect(issues).toMatchObject([{ code: "minDuration", actual: "1", expected: "2", index: 2, nodeId: "source" }]);
    render(<ReferenceValidationDialog open onClose={vi.fn()} issues={issues} />);
    expect(screen.getByText("bad_audio_duration_mp3_1s.mp3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "referenceValidation.locate" }));
    expect(focus).toHaveBeenCalledWith("source");
  });
  it("lists every source when total video duration exceeds the limit", () => {
    const rejection = audioReferenceDurationRejection([
      { label: "a.mp4", durationMs: 2000, nodeId: "first", index: 1 },
      { label: "b.mp4", durationMs: 2000, nodeId: "second", index: 2 },
    ], { minMs: null, maxMs: null, totalLimitMs: 3000, perClipLimits: false });
    expect(rejection?.kind).toBe("totalTooLong");
    if (!rejection) return;
    expect(referenceDurationIssues("video", rejection, {})).toMatchObject([
      { code: "totalMaxDuration", actual: "4", expected: "3", nodeId: "first" },
      { code: "totalMaxDuration", actual: "4", expected: "3", nodeId: "second" },
    ]);
  });
  it("lists every violation with actual/expected values and locates its source", () => {
    const close = vi.fn();
    const parentClick = vi.fn();
    render(<div onClick={parentClick}><ReferenceValidationDialog open onClose={close} issues={[
      { media: "image", index: 1, name: "same.png", reference_key: "a/same.png", code: "minWidth", actual: 299, expected: 300, nodeId: "source" },
      { media: "audio", index: 1, name: "voice.m4a", reference_key: "voice.m4a", code: "format", actual: "m4a", expected: ["wav", "mp3"] },
    ]} /></div>);
    expect(screen.getByText("referenceValidation.minWidth 299 300")).toBeInTheDocument();
    expect(screen.getByText("referenceValidation.format m4a wav, mp3")).toBeInTheDocument();
    expect(screen.getByText("voice.m4a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "referenceValidation.locate" }));
    expect(select).toHaveBeenCalledWith("source");
    expect(focus).toHaveBeenCalledWith("source");
    expect(close).toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
