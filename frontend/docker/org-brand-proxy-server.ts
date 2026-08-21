import { createServer, type Server } from "node:http";

import { handleOrgBrandAsset, type OrgBrandAssetOptions } from "./org-brand-assets";

function waitForDrain(target: import("node:http").ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.off("drain", onDrain);
      target.off("close", onClose);
      target.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("organization brand asset client disconnected"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    target.once("drain", onDrain);
    target.once("close", onClose);
    target.once("error", onError);
  });
}

export async function sendWebResponse(
  response: Response,
  target: import("node:http").ServerResponse,
): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  if (!response.body) {
    target.end();
    return;
  }

  target.flushHeaders();
  const reader = response.body.getReader();
  let complete = false;
  const cancelOnClose = () => {
    if (!complete) {
      void reader.cancel(new Error("organization brand asset client disconnected")).catch(() => {
        // The request path owns shutdown; cancellation failure must not escape globally.
      });
    }
  };
  target.once("close", cancelOnClose);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!target.write(value)) await waitForDrain(target);
    }
    complete = true;
    target.end();
  } finally {
    target.off("close", cancelOnClose);
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // The upstream stream is already unusable.
      }
    }
    reader.releaseLock();
  }
}

export function createOrgBrandProxyServer(options: OrgBrandAssetOptions): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const assetRequest = new Request(url, { method: request.method ?? "GET" });
    void (async () => {
      try {
        await sendWebResponse(await handleOrgBrandAsset(assetRequest, options), response);
      } catch (error) {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        await sendWebResponse(
          new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } }),
          response,
        );
      }
    })();
  });
}
