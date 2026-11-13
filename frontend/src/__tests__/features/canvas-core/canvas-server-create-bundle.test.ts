// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "vite";
import { expect, it } from "vitest";
import fixture from "./__parity__/canvas-creation.json";

it("serves canvas creation plans and descriptions from the standalone worker with an empty environment", async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-server-create-"));
  try {
    await build({ configFile: path.resolve("vite.canvas-server.config.ts"), envFile: false, build: { outDir } });
    const child = spawn(process.execPath, [path.join(outDir, "canvas-core-worker.mjs")], {
      env: {}, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const requests = fixture.cases.map(({ name, input, locale }) => ({
      id: name, op: "plan_canvas_creation", payload: {
        project_id: input.projectId,
        name: input.name,
        ...("creatorUsername" in input ? { creator_username: input.creatorUsername } : {}),
        request_id: input.requestId,
        save_source: input.saveSource,
        ...("canvases" in input ? { canvases: input.canvases } : {}),
        ...(input.origin ? { origin: { chat_canvas_id: input.origin.chatCanvasId, turn_id: input.origin.turnId } } : {}),
        env: { locale },
      },
    }));
    child.stdin.end([
      ...requests,
      { id: "describe", op: "describe_canvases", payload: {
        canvases: [
          { id: "default", modified_at: "2026-11-01T00:00:00Z", size: 1 },
          { id: "canvas_alice", modified_at: "2026-11-01T00:00:00Z", size: 1, metadata: {
            canvas_origin: "user_created", display_name: "Story lab", creator_username: "alice",
          } },
        ],
        viewer: { username: "alice" }, env: { locale: "en" },
      } },
      { id: "bad-plan", op: "plan_canvas_creation", payload: {} },
    ].map(request => JSON.stringify(request)).join("\n") + "\n");
    const timer = setTimeout(() => child.kill(), 50000);
    try { expect(await exit, stderr).toBe(0); } finally { clearTimeout(timer); }
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(fixture.cases).toHaveLength(30);
    expect(lines).toHaveLength(32);
    for (const [index, row] of fixture.cases.entries()) {
      expect.soft(lines[index], row.name).toEqual({ id: row.name, ok: true, result: row.expected });
    }
    expect.soft(lines[30]).toMatchObject({
      id: "describe", ok: true, result: { quota: { status: "available", used: 1, limit: 25 } },
    });
    expect(lines[31]).toMatchObject({ id: "bad-plan", ok: false, error: { code: "invalid_request" } });
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}, 60000);
