import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/components/login/login.module.css", "utf8");
const cardCss = readFileSync(
  "src/components/notifications/announcement-card.module.css",
  "utf8",
);
const source = readFileSync("src/components/login/cinematic/AnnouncementEntry.tsx", "utf8");
const drawerSource = readFileSync(
  "src/components/notifications/notification-drawer.tsx",
  "utf8",
);

function firstRule(selector: string): string {
  const match = css.match(new RegExp(`\\.${selector}\\s*\\{([\\s\\S]*?)\\}`));
  expect(match, `missing .${selector} rule`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("announcement dialog layout contract", () => {
  it("keeps the dialog title free of a redundant leading icon", () => {
    expect(source).not.toMatch(/announcementHeader[\s\S]*?<Bell aria-hidden="true" \/>[\s\S]*?<Dialog\.Title/);
    expect(css).not.toContain(".announcementHeader > svg");
  });

  it("sizes to its content instead of reserving an empty minimum height", () => {
    const dialog = firstRule("announcementDialog");
    expect(dialog).not.toMatch(/min-height\s*:/);
    expect(dialog).toMatch(/max-height:\s*min\(80dvh, 640px\)/);
  });

  it("uses one shared translucent blurred mask without nested dialog blur", () => {
    const overlay = firstRule("announcementOverlay");
    const dialog = firstRule("announcementDialog");
    expect(overlay).toContain("background: rgba(3, 4, 10, 0.5)");
    expect(overlay).toContain("backdrop-filter: blur(20px) saturate(112%)");
    expect(dialog).toContain("background: rgba(12, 13, 18, 0.72)");
    expect(dialog).not.toContain("backdrop-filter");
  });

  it("lets the list shrink into the bounded scroll region", () => {
    const body = firstRule("announcementBody");
    expect(body).toContain("flex: 0 1 auto");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("padding: 6px 16px 14px");
  });

  it("emphasizes critical time text without a pill container", () => {
    const time =
      cardCss.match(/\.highlightTime\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(time).toContain("color: rgba(120, 238, 248, 0.96)");
    expect(time).toContain("font-weight: 600");
    expect(time).not.toMatch(/(?:background|border|padding|margin)\s*:/);
  });

  it("uses the same shared card component before and after login", () => {
    expect(source).toContain("SharedAnnouncementCard");
    expect(drawerSource).toContain("SharedAnnouncementCard");
    expect(css).not.toContain(".announcementItem {");
    expect(firstRule("announcementList")).toContain("gap: 16px");
    expect(drawerSource).toContain('className="space-y-4"');
  });
});
