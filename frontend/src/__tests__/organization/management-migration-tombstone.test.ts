// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Tombstone for the organization-administration migration to the 5174 admin
// portal. Scope is deliberately narrow: catch a *direct* restoration of the
// removed routes, components, management API surface and copy. It is not a
// static-analysis framework and does not try to defeat obfuscated source
// constructions — `tsc` already constrains the retained client (`orgUrl`
// accepts the literal `"me"` only), and behaviour lives in the real tests.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

function sourceFiles(directory = "src"): string[] {
  const absolute = join(root, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    const projectPath = relative(root, path).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(projectPath);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [projectPath] : [];
  });
}

function matchingLines(path: string, pattern: RegExp, label: string): string[] {
  return source(path).split("\n").flatMap((line, index) => {
    pattern.lastIndex = 0;
    return pattern.test(line) ? [`${path}:${index + 1}: ${label}: ${line.trim()}`] : [];
  });
}

function scanProduction(pattern: RegExp, label: string): string[] {
  return sourceFiles().flatMap((path) => matchingLines(path, pattern, label));
}

const removedProductionFiles = [
  "src/routes/_app/organization.tsx",
  "src/routes/_app/organization.members.tsx",
  "src/routes/_app/organization.invites.tsx",
  "src/routes/_app/organization.gateway-key.tsx",
  "src/routes/invite.$token.tsx",
  "src/components/organization/organization-overview.tsx",
  "src/components/organization/organization-members.tsx",
  "src/components/organization/organization-invites.tsx",
  "src/components/organization/organization-gateway-key.tsx",
  "src/components/organization/invite-acceptance.tsx",
  "src/components/organization/member-input.ts",
  "src/components/organization/member-search.ts",
  "src/components/organization/invite-search.ts",
] as const;

const retainedBoundaryFiles = [
  "src/routes/login.tsx",
  "src/components/login/cinematic/LoginCinematicPage.tsx",
  "src/stores/auth-store.ts",
  "src/lib/org-access-state.ts",
  "src/routes/_app/access-unavailable.tsx",
  "src/components/organization/access-unavailable.tsx",
  "src/lib/queries/org.ts",
  "src/types/org.ts",
  "src/__tests__/lib/org-me-api.test.tsx",
  "src/routeTree.gen.ts",
] as const;

const managementSymbol =
  /\b(?:Organization(?:Overview|Members|Invites|GatewayKey)|InviteAcceptance|MemberInput|MemberSearch|InviteSearch|OrgMember|OrgInvite|GatewayKeyStatus|PutGatewayKeyRequest|DeleteGatewayKeyRequest|(?:list|add|patch|create|revoke|accept)Org(?:Member|Members|Invite)|(?:get|put|delete)OrgGatewayKey|useOrg(?:Members|Invites|GatewayKeyStatus|AddOrg|PatchOrg|CreateOrg|RevokeOrg|AcceptOrg)|org(?:Members|Invites|GatewayKey))\b/;

// Any `/api/v1/org…` reference that is not one of the two retained exact reads.
// The delimiter after the name matters: `/branding/logo` must remain forbidden.
const forbiddenOrgEndpoint =
  /\/api\/v1\/org\/(?!(?:me|branding)(?:["'`?#)]|$)|\$\{path\}`)/;

describe("organization administration migration tombstone", () => {
  it("removes organization management and invitation files", () => {
    expect(removedProductionFiles.filter((path) => existsSync(join(root, path)))).toEqual([]);
  });

  it("keeps organization management routes, links and symbols out of production source", () => {
    const findings = [
      ...scanProduction(/["'`]\/organization(?:\/|["'`])/, "organization route/link"),
      ...scanProduction(/["'`]\/invite\//, "invitation route/link"),
      ...scanProduction(managementSymbol, "organization management symbol"),
      ...scanProduction(
        /(?:localhost:5174|127\.0\.0\.1:5174|\bSuperTale Admin\b|https?:\/\/[^\s"'`]*admin[^\s"'`]*)/i,
        "cross-product admin link",
      ),
    ];

    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("exposes only the strict cookie-backed organization reads", () => {
    const forbidden = scanProduction(forbiddenOrgEndpoint, "forbidden organization endpoint");
    const orgQueries = source("src/lib/queries/org.ts");
    const brandingQueries = source("src/lib/queries/org-branding.ts");
    const apiCalls = orgQueries.match(/\bapi\.(?:get|post|put|patch|delete)\(/g) ?? [];
    const brandingApiCalls =
      brandingQueries.match(/\bapi\.(?:get|post|put|patch|delete)\(/g) ?? [];
    const exportedNames = [...orgQueries.matchAll(
      /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/gm,
    )].map((match) => match[1]).sort();

    expect(forbidden, forbidden.join("\n")).toEqual([]);
    // `orgUrl(path: "me")` is type-constrained, so a single `api.get(orgUrl("me"))`
    // is the whole organization wire surface the product frontend may reach.
    expect(apiCalls).toEqual(["api.get("]);
    expect(orgQueries).toContain('api.get(orgUrl("me"))');
    expect(orgQueries).toContain('function orgUrl(path: "me")');
    expect(exportedNames).toEqual(["OrgApiError", "getOrgMe", "useOrgMe"]);
    // Branding is decorative and read-only. Pin both retry layers here so this
    // narrow exception cannot grow into a management client or noisy fallback.
    expect(brandingApiCalls).toEqual(["api.get("]);
    expect(brandingQueries).toContain('new URL("/api/v1/org/branding"');
    expect(brandingQueries).toContain("api.get(url, { retry: 0 })");
    expect(brandingQueries).toContain("retry: false");
  });

  it("keeps manage_invites as a wire-only field, never UI authority", () => {
    const occurrences = sourceFiles().flatMap((path) =>
      matchingLines(path, /\bmanage_invites\b/, "manage_invites"),
    );

    // Exactly two: the `OrgCapabilities` wire type and the strict parser's
    // allowed-capability key set. No component, route or guard may read it.
    expect(occurrences.map((line) => line.split(":")[0])).toEqual([
      "src/lib/queries/org.ts",
      "src/types/org.ts",
    ]);
  });

  it("keeps tests off the removed management surfaces", () => {
    const findings = sourceFiles("src/__tests__").flatMap((path) => {
      if (path.endsWith("management-migration-tombstone.test.ts")) return [];
      return [
        ...matchingLines(
          path,
          /from\s+["'][^"']*(?:organization\/(?!access-unavailable)|routes\/(?:invite|_app\/organization))/,
          "removed management import",
        ),
        ...matchingLines(path, managementSymbol, "removed management symbol"),
        ...matchingLines(path, forbiddenOrgEndpoint, "removed management endpoint"),
      ];
    });

    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("physically retains login and the organization access-only boundary", () => {
    const missing = retainedBoundaryFiles.filter((path) => !existsSync(join(root, path)));
    const loginRoute = source("src/routes/login.tsx");
    const authStore = source("src/stores/auth-store.ts");
    const routeTree = source("src/routeTree.gen.ts");

    expect(missing, missing.join("\n")).toEqual([]);
    expect(loginRoute).toContain('createFileRoute("/login")');
    expect(loginRoute).toContain("component: LoginCinematicPage");
    expect(authStore).toContain('fetch("/api/v1/auth/login"');
    expect(authStore).toContain('credentials: "include"');
    expect(routeTree).toContain("/_app/access-unavailable");
    expect(routeTree).toContain("/access-unavailable");
    expect(routeTree).not.toMatch(/["']\/organization(?:\/|["'])/);
    expect(routeTree).not.toContain("/invite/$token");
  });

  it("retains access-only copy while removing management and invitation copy", () => {
    const en = JSON.parse(source("public/locales/en/translation.json")) as Record<string, unknown>;
    const zh = JSON.parse(source("public/locales/zh/translation.json")) as Record<string, unknown>;

    expect(en).toHaveProperty("organization.access");
    expect(zh).toHaveProperty("organization.access");
    for (const locale of [en, zh]) {
      expect(locale).not.toHaveProperty("invite");
      expect(locale).not.toHaveProperty("organization.members");
      expect(locale).not.toHaveProperty("organization.invites");
      expect(locale).not.toHaveProperty("organization.gatewayKey");
    }
  });

  it("uses ordinary global nginx policy with no invitation exceptions", () => {
    const nginx = source("docker/nginx.conf.template");

    expect(nginx).toContain("access_log /var/log/nginx/access.log combined;");
    expect(nginx).toContain('add_header Cache-Control "no-cache" always;');
    expect(nginx).toContain('add_header Referrer-Policy "strict-origin-when-cross-origin" always;');
    expect(nginx).not.toContain("$invite_");
    expect(nginx).not.toMatch(/\^\\?\/invite\//);
    expect(nginx).not.toContain("/api/v1/org/invites/");
    expect(nginx).not.toContain('add_header Referrer-Policy "no-referrer"');
    expect(nginx).not.toContain('add_header Cache-Control "no-store"');
  });

  it("does not retain CE-gated organization management dead code", () => {
    const allowedCeBoundary = new Set(["src/routes/_app/access-unavailable.tsx"]);
    const findings = sourceFiles().flatMap((path) => {
      if (!source(path).includes("isCeRuntime") || allowedCeBoundary.has(path)) return [];
      const matches = matchingLines(
        path,
        /(?:organization|invite|OrgMember|OrgInvite|GatewayKey)/,
        "CE-gated organization management",
      );
      // The Header may read the active organization's name only to label the
      // decorative co-brand link; keep every other management-shaped match.
      return matches.filter(
        (line) => !(
          path === "src/components/layout/header.tsx" &&
          line.includes("orgBranding.data") &&
          line.includes("organization?.name")
        ),
      );
    });

    expect(findings, findings.join("\n")).toEqual([]);
  });
});
