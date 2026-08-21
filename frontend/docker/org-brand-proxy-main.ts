import { createOrgBrandProxyServer } from "./org-brand-proxy-server";

const backendHost = process.env.BACKEND_HOST || "novelvideo-ui-staging";
const backendPort = process.env.BACKEND_PORT || "8780";
const server = createOrgBrandProxyServer({
  assetOrigin:
    process.env.ORG_BRAND_ASSET_ORIGIN || `http://${backendHost}:${backendPort}`,
});

server.listen(3001, "127.0.0.1");

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
