import type { Plugin } from "vite";

import { isOrgBrandAssetRequest } from "./org-brand-assets";
import { createOrgBrandProxyHandler } from "./org-brand-proxy-server";

export function createOrgBrandAssetDevPlugin(assetOrigin: string): Plugin {
  const handler = createOrgBrandProxyHandler({ assetOrigin });
  return {
    name: "org-brand-asset-dev-proxy",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!isOrgBrandAssetRequest(url)) {
          next();
          return;
        }
        handler(request, response);
      });
    },
  };
}
