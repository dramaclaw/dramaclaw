// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nginx = readFileSync(
  `${process.cwd()}/docker/nginx.conf.template`,
  "utf8",
);

describe("public invitation hosting policy", () => {
  it("uses the original request path for /invite/* headers across SPA rewrites", () => {
    expect(nginx).toMatch(/map\s+\$request_uri\s+\$invite_referrer_policy[\s\S]*~\^\/invite\/\s+no-referrer[\s\S]*default\s+strict-origin-when-cross-origin/);
    expect(nginx).toMatch(/map\s+\$request_uri\s+\$invite_cache_control[\s\S]*~\^\/invite\/\s+no-store[\s\S]*default\s+no-cache/);
    expect(nginx).not.toMatch(/map\s+\$uri\s+\$invite_(?:referrer_policy|cache_control)/);
    expect(nginx).toContain("try_files $uri $uri/ /index.html;");
    expect(nginx).toContain('add_header Referrer-Policy $invite_referrer_policy always;');
    expect(nginx).toContain('add_header Cache-Control $invite_cache_control always;');
  });

  it("suppresses access logs only for raw-token invite shell, preview and accept paths", () => {
    expect(nginx).toMatch(/map\s+\$request_uri\s+\$invite_access_log[\s\S]*default\s+1/);
    expect(nginx).toMatch(/~\^\/invite\//);
    expect(nginx).toMatch(/~\^\/api\/v1\/org\/invites\/[^\n]+preview\|accept/);
    expect(nginx).toContain("access_log /var/log/nginx/access.log combined if=$invite_access_log;");
  });
});
