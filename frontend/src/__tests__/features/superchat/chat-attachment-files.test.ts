import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api", () => ({ uploadApi: { post: apiMocks.post } }));

import {
  composerFileAttachment,
  uploadHomeAttachments,
} from "@/features/superchat/chat-attachment-files";

const NOTES = "# 大纲\n第一幕";
const NOTES_URL = "/api/v1/chat/uploads/b6aa2a754278da9f-notes.md";

function notesFile(): File {
  return new File([NOTES], "notes.md", { type: "text/markdown" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("composer file attachments", () => {
  beforeEach(() => {
    apiMocks.post.mockReset();
  });

  it("describes a picked file without its bytes", () => {
    expect(composerFileAttachment(notesFile(), "att-1")).toEqual({
      id: "att-1",
      type: "file",
      mimeType: "text/markdown",
      fileName: "notes.md",
      fileSize: 18,
    });
  });

  it("uploads a home attachment and sends only the returned address", async () => {
    apiMocks.post.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        data: { url: NOTES_URL, fileName: "notes.md", fileSize: 18, mimeType: "text/markdown" },
      }),
    );
    const file = notesFile();
    const attachment = composerFileAttachment(file, "att-1");

    const prepared = await uploadHomeAttachments([attachment], new Map([["att-1", file]]));

    expect(prepared).toEqual([
      {
        original: attachment,
        attachment: {
          id: "att-1",
          type: "file",
          mimeType: "text/markdown",
          fileName: "notes.md",
          fileSize: 18,
          url: NOTES_URL,
        },
      },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("data:");
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    const [path, options] = apiMocks.post.mock.calls[0] as [string, { body: FormData }];
    expect(path).toBe("api/v1/chat/uploads");
    const sent = options.body.get("file") as File;
    expect(sent.name).toBe("notes.md");
    expect(await sent.text()).toBe(NOTES);
  });

  it("keeps a home attachment without an address when its upload is rejected", async () => {
    apiMocks.post.mockResolvedValue(
      jsonResponse(413, { detail: "file exceeds the 209715200 byte upload limit" }),
    );
    const file = notesFile();
    const attachment = composerFileAttachment(file, "att-1");

    const prepared = await uploadHomeAttachments([attachment], new Map([["att-1", file]]));

    expect(prepared).toEqual([
      {
        original: attachment,
        attachment,
        error: "file exceeds the 209715200 byte upload limit",
      },
    ]);
  });

  it("passes through attachments that have no picked file", async () => {
    const reference = { id: "canvas-ref:c1", type: "canvas_node_reference", label: "主角" };

    const prepared = await uploadHomeAttachments([reference], new Map());

    expect(prepared).toEqual([{ original: reference, attachment: reference }]);
    expect(apiMocks.post).not.toHaveBeenCalled();
  });
});
