import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("organization brand asset deployment contract", () => {
  it("uses the built-in Vite proxy for the exact fixed public path", () => {
    const config = readFileSync("vite.config.ts", "utf8");

    expect(config).toContain('"^/assets/org-brand/[A-Za-z0-9_-]+/logo$"');
    expect(config).toContain("target: apiTarget");
    expect(config).toContain('path.replace("/assets/org-brand/", "/api/v1/org-brand/")');
    expect(config).toContain('proxyReq.removeHeader("cookie")');
    expect(config).toContain('proxyReq.removeHeader("authorization")');
    expect(config).not.toContain("createOrgBrandAssetDevPlugin");
  });

  it("routes only the exact fixed logo path directly to the existing backend", () => {
    const config = readFileSync("docker/nginx.conf.template", "utf8");
    const block = config.match(
      /location ~ \^\/assets\/org-brand([\s\S]*?)\n    \}/,
    )?.[1];

    expect(block).toContain("/([A-Za-z0-9_-]+)/logo$");
    expect(block).toContain("limit_except GET HEAD");
    expect(block).toContain('if ($args != "") { return 404; }');
    expect(block).toContain("proxy_pass http://supertale_backend/api/v1/org-brand/$1/logo");
    expect(block).toContain("proxy_pass_request_headers off");
    expect(block).not.toContain("127.0.0.1:3001");
    expect(config.indexOf("location ~ ^/assets/org-brand")).toBeLessThan(
      config.indexOf("location /assets/"),
    );
  });

  it("keeps the runtime as the standard static Nginx container", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const packageJson = readFileSync("package.json", "utf8");

    expect(dockerfile).toContain("RUN pnpm build");
    expect(dockerfile).not.toContain("apk add --no-cache nodejs");
    expect(dockerfile).not.toContain("org-brand-proxy-server.mjs");
    expect(dockerfile).not.toContain("docker/start.sh");
    expect(packageJson).not.toContain("build:org-brand-proxy");
  });

  it("does not retain the removed companion implementation", () => {
    for (const file of [
      "docker/org-brand-assets.ts",
      "docker/org-brand-proxy-main.ts",
      "docker/org-brand-proxy-server.test.ts",
      "docker/org-brand-proxy-server.ts",
      "docker/start.sh",
      "docker/tsconfig.json",
      "docker/vite-org-brand-proxy.ts",
      "docker/vite.proxy.config.ts",
    ]) {
      expect(existsSync(file), file).toBe(false);
    }
  });
});
