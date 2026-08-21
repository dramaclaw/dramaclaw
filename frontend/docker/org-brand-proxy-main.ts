import { createOrgBrandProxyServer } from "./org-brand-proxy-server";

const server = createOrgBrandProxyServer({
  assetOrigin: process.env.ORG_BRAND_ASSET_ORIGIN ?? "",
});

server.listen(3001, "127.0.0.1");

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
