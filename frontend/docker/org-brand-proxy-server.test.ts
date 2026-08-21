import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrgBrandProxyServer, sendWebResponse } from "./org-brand-proxy-server";
import { handleOrgBrandAsset } from "./org-brand-assets";

const logoPath =
  "/assets/org-brand/sha256/ab/cd/" + "abcd" + "0".repeat(60) + ".png";
const servers: ReturnType<typeof createOrgBrandProxyServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
});

async function start(fetcher: typeof fetch) {
  const server = createOrgBrandProxyServer({
    assetOrigin: "https://assets.example",
    fetcher,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

describe("organization brand asset companion", () => {
  it("returns an empty no-store 502 after the total upstream deadline", async () => {
    const response = await handleOrgBrandAsset(
      new Request(`https://dramaclaw.example${logoPath}`),
      {
        assetOrigin: "https://assets.example",
        timeoutMs: 5,
        fetcher: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return new Response("image", { headers: { "content-type": "image/png" } });
        }),
      },
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it.each(["GET", "HEAD"])(
    "fails closed for a %s response without a valid Content-Length",
    async (method) => {
      const cancelled = vi.fn();
      const response = await handleOrgBrandAsset(
        new Request(`https://dramaclaw.example${logoPath}`, { method }),
        {
          assetOrigin: "https://assets.example",
          fetcher: vi.fn(async () => new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
            cancel: cancelled,
          }), { headers: { "content-type": "image/png" } })),
        },
      );

      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(cancelled).toHaveBeenCalledOnce();
    },
  );

  it("fails closed for an invalid Content-Length", async () => {
    const response = await handleOrgBrandAsset(
      new Request(`https://dramaclaw.example${logoPath}`),
      {
        assetOrigin: "https://assets.example",
        fetcher: vi.fn(async () => new Response("image", {
          headers: { "content-type": "image/png", "content-length": "5x" },
        })),
      },
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("allows a normalized logo larger than the multipart envelope", async () => {
    const body = new Uint8Array(12 * 1024 * 1024);
    const response = await handleOrgBrandAsset(
      new Request("https://dramaclaw.example" + logoPath),
      {
        assetOrigin: "https://assets.example",
        fetcher: vi.fn(async () => new Response(body, {
          headers: {
            "content-type": "image/png",
            "content-length": String(body.byteLength),
          },
        })),
      },
    );

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(body.byteLength);
  });

  it.each(["GET", "HEAD"])(
    "cancels a %s body whose declared length exceeds the object limit",
    async (method) => {
    const cancelled = vi.fn();
    const response = await handleOrgBrandAsset(
      new Request("https://dramaclaw.example" + logoPath, { method }),
      {
        assetOrigin: "https://assets.example",
        maxBytes: 4,
        fetcher: vi.fn(async () => new Response(new ReadableStream({
          cancel: cancelled,
        }), {
          headers: { "content-type": "image/png", "content-length": "5" },
        })),
      },
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cancelled).toHaveBeenCalledOnce();
    },
  );

  it("applies the same deadline while reading the upstream body", async () => {
    const response = await handleOrgBrandAsset(
      new Request(`https://dramaclaw.example${logoPath}`),
      {
        assetOrigin: "https://assets.example",
        timeoutMs: 5,
        fetcher: vi.fn(async (_url, init) => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("upstream aborted"));
            });
          },
        }), {
          headers: { "content-type": "image/png", "content-length": "2" },
        })),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("cancels an invalid upstream response body", async () => {
    const cancelled = vi.fn();
    const response = await handleOrgBrandAsset(
      new Request(`https://dramaclaw.example${logoPath}`),
      {
        assetOrigin: "https://assets.example",
        fetcher: vi.fn(async () => new Response(new ReadableStream({
          cancel: cancelled,
        }), { status: 500 })),
      },
    );

    expect(response.status).toBe(500);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rewrites the web path and allowlists successful image headers", async () => {
    const upstream = vi.fn(async () => new Response("image", {
      headers: {
        "content-type": "image/png",
        "content-length": "5",
        location: "https://assets.example/private",
        "set-cookie": "secret=1",
      },
    }));
    const port = await start(upstream);

    const response = await fetch(`http://127.0.0.1:${port}${logoPath}`);

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(
      `https://assets.example${logoPath.replace("/assets", "")}`,
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("forwards the upstream body before it finishes instead of aggregating it", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }), {
      headers: { "content-type": "image/png", "content-length": "6" },
    }));
    const port = await start(upstream as typeof fetch);

    const responsePromise = fetch(`http://127.0.0.1:${port}${logoPath}`);
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
    controller?.enqueue(new TextEncoder().encode("abc"));
    const arrivedBeforeClose = await Promise.race([
      responsePromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    controller?.enqueue(new TextEncoder().encode("def"));
    controller?.close();
    const response = await responsePromise;

    expect(arrivedBeforeClose).toBe(true);
    expect(await response.text()).toBe("abcdef");
  });

  it("waits for drain before reading and writing the next upstream chunk", async () => {
    class BackpressureTarget extends EventEmitter {
      statusCode = 0;
      writes: Uint8Array[] = [];
      ended = false;

      setHeader() {}
      flushHeaders() {}
      write(value: Uint8Array) {
        this.writes.push(value);
        return this.writes.length > 1;
      }
      end() {
        this.ended = true;
      }
    }

    const target = new BackpressureTarget();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("def"));
        controller.close();
      },
    }), { headers: { "content-length": "6" } });
    const sending = sendWebResponse(
      response,
      target as unknown as import("node:http").ServerResponse,
    );

    await vi.waitFor(() => expect(target.writes).toHaveLength(1));
    expect(target.ended).toBe(false);
    target.emit("drain");
    await sending;

    expect(target.writes.map((value) => new TextDecoder().decode(value))).toEqual(["abc", "def"]);
    expect(target.ended).toBe(true);
  });

  it("handles a rejected cancellation when client disconnect races with upstream failure", async () => {
    class DisconnectTarget extends EventEmitter {
      statusCode = 0;
      ended = false;

      setHeader() {}
      flushHeaders() {}
      write() { return true; }
      end() { this.ended = true; }
    }

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const target = new DisconnectTarget();
      const response = new Response(new ReadableStream({
        cancel() {
          return Promise.reject(new Error("cancel failed"));
        },
      }));
      const sending = sendWebResponse(
        response,
        target as unknown as import("node:http").ServerResponse,
      );

      target.emit("close");
      await sending;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each([302, 404, 500])("does not cache or leak an upstream %s", async (status) => {
    const port = await start(vi.fn(async () => new Response(null, {
      status,
      headers: { location: "https://assets.example/private", "set-cookie": "secret=1" },
    })));

    const response = await fetch(`http://127.0.0.1:${port}${logoPath}`);

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("rejects queries and a 200 HTML response", async () => {
    const port = await start(vi.fn(async () => new Response("<html>bad</html>", {
      headers: { "content-type": "text/html", "set-cookie": "secret=1" },
    })));

    const queried = await fetch(`http://127.0.0.1:${port}${logoPath}?secret=1`);
    const html = await fetch(`http://127.0.0.1:${port}${logoPath}`);

    expect(queried.status).toBe(404);
    expect(queried.headers.get("cache-control")).toBe("no-store");
    expect(html.status).toBe(502);
    expect(html.headers.get("cache-control")).toBe("no-store");
    expect(html.headers.has("set-cookie")).toBe(false);
  });
});
