import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeMessage } from "@/features/superchat/message";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const OUTPUT_URL = "/static/projects/p/output/shot-1.png";

describe("history message attachments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not turn a content block's inline source data into an attachment", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const message = normalizeMessage({
      id: "m1",
      role: "user",
      text: "看图",
      content: [
        {
          type: "image",
          id: "img-1",
          fileName: "shot.png",
          source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
        },
      ],
    });

    expect(message?.attachments).toEqual([
      { id: "img-1", type: "image", mimeType: "image/png", fileName: "shot.png" },
    ]);
    expect(JSON.stringify(message?.attachments)).not.toContain(PNG_BASE64);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops inline data addresses from media and logs the count without the payload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const message = normalizeMessage({
      id: "m2",
      role: "assistant",
      text: "生成好了",
      media: [
        { kind: "image", url: PNG_DATA_URL, path: ` ${PNG_DATA_URL}`, label: "草图" },
        { kind: "image", url: OUTPUT_URL },
      ],
    });

    expect(message?.attachments).toEqual([
      { id: "image:草图", type: "image", kind: "image", fileName: "草图", label: "草图" },
      {
        id: `image:${OUTPUT_URL}`,
        type: "image",
        kind: "image",
        fileName: "shot-1.png",
        content: OUTPUT_URL,
        url: OUTPUT_URL,
      },
    ]);
    expect(JSON.stringify(message?.attachments)).not.toContain("data:");
    expect(warn.mock.calls).toEqual([
      ["[superchat] dropped %d inline data value(s) from chat history", 2],
    ]);
  });
});
