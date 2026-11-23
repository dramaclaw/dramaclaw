// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The remote MCP entry is mounted by the API at /mcp, outside /api/. MCP clients are
// given the web address, so the web server must forward /mcp/ to the API instead of
// answering it with the SPA shell.
describe("remote MCP deployment contract", () => {
  it("forwards /mcp/ to the backend in the production Nginx template", () => {
    const config = readFileSync("docker/nginx.conf.template", "utf8");
    const block = config.match(/location \/mcp\/ \{([\s\S]*?)\n    \}/)?.[1];

    expect(block).toBeDefined();
    expect(block).toContain("proxy_pass http://supertale_backend;");
    expect(block).toContain("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
    expect(block).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    // Tool calls can run for a long time and the responses must not be held back.
    expect(block).toContain("proxy_buffering off;");
    expect(block).toContain("proxy_request_buffering off;");
    expect(block).toMatch(/proxy_read_timeout \d+s;/);
  });

  it("forwards /mcp to the backend from the dev server", () => {
    const config = readFileSync("vite.config.ts", "utf8");
    const block = config.match(/"\/mcp": \{([\s\S]*?)\n        \},/)?.[1];

    expect(block).toBeDefined();
    expect(block).toContain("target: apiTarget");
  });
});
