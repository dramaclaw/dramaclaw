import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

describe("organization brand asset deployment contract", () => {
  it("routes only exact immutable asset paths to a fail-closed companion", () => {
    const config = readFileSync("docker/nginx.conf.template", "utf8");
    const block = config.match(
      /location ~ \^\/assets\/org-brand([\s\S]*?)\n    \}/,
    )?.[1];

    expect(block).toContain("limit_except GET HEAD");
    expect(block).toContain('if ($args != "") { return 404; }');
    expect(block).toContain("proxy_pass http://127.0.0.1:3001");
    expect(block).not.toContain("ORG_BRAND_ASSET_ORIGIN");
    expect(block).not.toContain("immutable");
    expect(config.indexOf("location ~ ^/assets/org-brand")).toBeLessThan(
      config.indexOf("location /assets/"),
    );
  });

  it("runs the validator companion with the public asset origin", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const proxyBuild = readFileSync("docker/vite.proxy.config.ts", "utf8");

    expect(dockerfile).toContain(
      'NGINX_ENVSUBST_FILTER="^(BACKEND_HOST|BACKEND_PORT)$"',
    );
    expect(dockerfile).toContain(
      "ORG_BRAND_ASSET_ORIGIN=https://novelvideo-assets-chengdu.oss-cn-chengdu.aliyuncs.com",
    );
    expect(dockerfile).toContain("apk add --no-cache nodejs");
    expect(dockerfile).toContain("org-brand-proxy-server.mjs");
    expect(dockerfile).toContain('CMD ["/opt/dramaclaw/start.sh"]');
    expect(proxyBuild).toContain("copyPublicDir: false");
  });

  it("keeps Nginx alive and restarts the brand companion after it exits", async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "brand-proxy-supervisor-"));
    const marker = path.join(fixture, "marker.txt");
    const brand = path.join(fixture, "brand.mjs");
    const nginx = path.join(fixture, "nginx-entrypoint.sh");
    writeFileSync(brand, [
      'import { appendFileSync } from "node:fs";',
      'appendFileSync(process.env.SUPERVISOR_MARKER, "brand-started\\n");',
      'process.exit(9);',
    ].join("\n"));
    writeFileSync(nginx, [
      "#!/bin/sh",
      'echo "nginx-started" >> "$SUPERVISOR_MARKER"',
      "trap 'exit 0' TERM INT",
      "while :; do sleep 1; done",
    ].join("\n") + "\n");
    chmodSync(nginx, 0o755);

    const supervisor = spawn("sh", ["docker/start.sh", brand, nginx], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SUPERVISOR_MARKER: marker,
        ORG_BRAND_RESTART_DELAY_SECONDS: "0.02",
      },
      stdio: "pipe",
    });
    try {
      const outcome = await Promise.race([
        once(supervisor, "exit").then(() => "exited"),
        (async () => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const lifecycle = (() => {
              try {
                return readFileSync(marker, "utf8");
              } catch {
                return "";
              }
            })();
            if (
              (lifecycle.match(/brand-started/g) ?? []).length >= 2 &&
              lifecycle.includes("nginx-started")
            ) return lifecycle;
            await delay(20);
          }
          return "timed-out";
        })(),
      ]);

      expect(outcome).not.toBe("exited");
      expect(outcome).not.toBe("timed-out");
      expect(outcome).toContain("nginx-started");
      expect(supervisor.exitCode).toBeNull();
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM");
        await once(supervisor, "exit");
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 20_000);
});
