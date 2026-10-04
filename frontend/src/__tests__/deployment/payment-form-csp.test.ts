import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function validate(origins: string) {
  return spawnSync("sh", ["-ec", '. ./docker/19-payment-form-csp.envsh; printf "%s" "$CSP_PAYMENT_FORM_ORIGINS"'], {
    encoding: "utf8",
    env: { ...process.env, CSP_PAYMENT_FORM_ORIGINS: origins },
  });
}

describe("payment form CSP", () => {
  it.each(["", "https://pay.example.test", "https://pay.example.test:9443", "https://pay.example.test https://other.example.test"])("accepts exact HTTPS origins: %s", (origins) => {
    const result = validate(origins);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(origins);
  });

  it("normalizes whitespace without joining origins", () => {
    const result = validate(" https://pay.example.test\n https://other.example.test  ");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("https://pay.example.test https://other.example.test");
  });

  it.each([
    "https:", "https://", "*", "https://*.example.test", "http://pay.example.test",
    "https://pay.example.test/path", "https://pay.example.test?query=1",
    "https://user@pay.example.test", "https://pay.example.test#fragment",
    "https://pay.example.test; script-src *", 'https://pay.example.test"',
    "https://pay.example.test/$host", "https://pay..example.test",
    "https://-pay.example.test", "https://pay.example.test:0", "https://pay.example.test:65536",
  ])("rejects unsafe source syntax: %s", (origins) => {
    expect(validate(origins).status).not.toBe(0);
  });

  it("renders only explicit form destinations while preserving Nginx variables", () => {
    const template = readFileSync("docker/nginx.conf.template", "utf8");
    const result = validate("https://pay.example.test");
    const rendered = template.replace(/\$\{CSP_PAYMENT_FORM_ORIGINS\}/g, result.stdout);
    expect(rendered.match(/form-action ([^;]+);/)?.[1]).toBe("'self' https://pay.example.test");
    expect(rendered).toContain("${csp_upgrade}");
    const defaultConfig = template.replace(/\$\{CSP_PAYMENT_FORM_ORIGINS\}/g, validate("").stdout);
    expect(defaultConfig.match(/form-action ([^;]+);/)?.[1]?.trim()).toBe("'self'");
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile.match(/COPY --chmod=755 docker\/19-payment-form-csp.envsh/g)).toHaveLength(2);
    expect(dockerfile.match(/NGINX_ENVSUBST_FILTER="\^\(BACKEND_HOST\|BACKEND_PORT\|CSP_PAYMENT_FORM_ORIGINS\)\$"/g)).toHaveLength(2);
  });
});
