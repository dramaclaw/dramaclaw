import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("@/lib/api", async () => {
  const { default: ky } = await import("ky");
  return { api: ky.create({ prefix: "http://localhost/", fetch: mocks.fetch, retry: 0 }) };
});

import {
  decideCanvasConfirmation,
  listCanvasConfirmations,
  type CanvasConfirmation,
} from "@/features/superchat/canvas-confirmations";

const confirmation: CanvasConfirmation = {
  id: "cc_00000000000000000000000000000001",
  agent_id: "main",
  turn_id: "turn-1",
  kinds: ["delete_nodes", "paid_generation"],
  targets: [
    { node_id: "n1", title: "开场图", node_type: "imageGenNode", action: "delete_nodes" },
    { node_id: "n2", title: "", node_type: "videoNode", action: "generate_video" },
  ],
  command_hash: "abc",
  created_at: 1000,
  expires_at: 2800,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

beforeEach(() => { mocks.fetch.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("canvas confirmation API", () => {
  it("posts the exact turn-bound card decision and returns response data", async () => {
    let sentPath = "";
    let sentMethod = "";
    let sentBody: unknown;
    mocks.fetch.mockImplementation(async (input) => {
      const request = new Request(input);
      sentPath = new URL(request.url).pathname.slice(1);
      sentMethod = request.method;
      sentBody = await request.json();
      return response({ ok: true, data: { confirmation_id: confirmation.id, status: "submitted" } });
    });
    const result = await decideCanvasConfirmation({
      projectId: "p1", canvasId: "c1", confirmation, decision: "confirmed",
    });
    expect(sentPath).toBe("api/v1/projects/p1/freezone/canvases/c1/confirmations/cc_00000000000000000000000000000001/decision");
    expect(sentMethod).toBe("POST");
    expect(sentBody).toEqual({
      decision: "confirmed", via: "card", agent_id: "main", turn_id: "turn-1", command_hash: "abc",
    });
    expect(result).toEqual({
      confirmation_id: "cc_00000000000000000000000000000001", status: "submitted",
    });
  });

  it("surfaces the backend 409 message verbatim", async () => {
    mocks.fetch.mockResolvedValue(response({
      detail: { code: "canvas_browser_required", message: "需要打开画布才能运行" },
    }, 409));
    await expect(decideCanvasConfirmation({
      projectId: "p1", canvasId: "c1", confirmation, decision: "confirmed",
    })).rejects.toThrow(new Error("需要打开画布才能运行"));
  });

  it("uses the translated fallback when an HTTP error has no message", async () => {
    mocks.fetch.mockResolvedValue(response({ detail: { code: "failed" } }, 400));
    await expect(decideCanvasConfirmation({
      projectId: "p1", canvasId: "c1", confirmation, decision: "refused",
    })).rejects.toThrow(new Error("操作失败，请重试。"));
  });

  it("lists confirmations with repeated agent query parameters", async () => {
    let sentUrl = "";
    mocks.fetch.mockImplementation(async (input) => {
      sentUrl = new Request(input).url;
      return response({ ok: true, data: { confirmations: [confirmation] } });
    });
    const result = await listCanvasConfirmations({
      projectId: "p1", canvasId: "c1", agentIds: ["main", "helper"],
    });
    expect(sentUrl).toBe("http://localhost/api/v1/projects/p1/freezone/canvases/c1/confirmations?agent_ids=main&agent_ids=helper");
    expect(result).toEqual([confirmation]);
  });
});
