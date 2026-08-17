// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * File uploads must not run on a timed-out HTTP client.
 *
 * ky's `timeout` covers the whole fetch, request body included, so on an
 * upload the clock races the user's uplink instead of the server: a 4 MB
 * portrait on a slow link blows past the 30s default and gets aborted
 * mid-body — the edge logs HTTP 499 with `upstream_addr: "-"` and the backend
 * never sees the file. Users read that as "upload failed, try again".
 *
 * The rule is easy to break by accident (a new upload naturally reaches for
 * the ambient `api` client), so it is checked at the source level rather than
 * left to review.
 */

const SOURCE_ROOT = "src";

/** How far past `new FormData` to look for the client call. */
const WINDOW_LINES = 25;

/** Ways a call site can legitimately escape the 30s default. */
const NO_TIMEOUT_PATTERNS = [
  // The shared no-timeout client (lib/api.ts).
  /\buploadApi\b/,
  // An explicit opt-out on a one-off call (api/client.ts callers).
  /timeout:\s*false/,
  /timeout:\s*options\?\.timeoutMs\s*\?\?\s*false/,
  // Raw fetch has no timeout of its own — nothing to opt out of.
  /\bfetch\(/,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Test fixtures build FormData for assertions, not for real uploads.
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** Every `new FormData` in the app, with the code that follows it. */
function uploadSites(): { file: string; line: number; window: string }[] {
  const sites: { file: string; line: number; window: string }[] = [];
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, index) => {
      if (!text.includes("new FormData(")) return;
      sites.push({
        file,
        line: index + 1,
        window: lines.slice(index, index + WINDOW_LINES).join("\n"),
      });
    });
  }
  return sites;
}

describe("upload timeout contract", () => {
  it("finds the upload sites at all (guards against the scan silently going blind)", () => {
    expect(uploadSites().length).toBeGreaterThan(15);
  });

  it("sends every multipart upload on a client with no request timeout", () => {
    const offenders = uploadSites()
      .filter((site) => !NO_TIMEOUT_PATTERNS.some((re) => re.test(site.window)))
      .map((site) => `${site.file}:${site.line}`);

    // Use `uploadApi` from @/lib/api (or `timeout: false` when on another
    // client) — see the comment on uploadApi for why a clock is wrong here.
    expect(offenders).toEqual([]);
  });

  it("keeps uploadApi itself timeout-free", () => {
    const source = readFileSync("src/lib/api.ts", "utf8");
    expect(source).toContain("export const uploadApi = api.extend({ timeout: false });");
  });
});
