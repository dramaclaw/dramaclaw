import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const html = readFileSync("index.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
function bootstrap(stored: string | null, systemDark = false, failStorage = false) {
  const classes: string[] = [];
  runInNewContext(script, {
    localStorage: { getItem() { if (failStorage) throw new Error("denied"); return stored; } },
    window: { matchMedia: () => ({ matches: systemDark }), location: { pathname: "/" } },
    document: { documentElement: { classList: { add: (value: string) => classes.push(value) }, style: {} } },
  });
  return classes;
}
it("uses the app's dark default before React, including corrupt or inaccessible storage", () => {
  expect(bootstrap(null)).toEqual(["dark"]);
  expect(bootstrap("broken")).toEqual(["dark"]);
  expect(bootstrap(null, false, true)).toEqual(["dark"]);
  expect(bootstrap(JSON.stringify({ state: { theme: "invalid" } }))).toEqual(["dark"]);
});
it("honors explicit light and system preferences", () => {
  expect(bootstrap(JSON.stringify({ state: { theme: "light" } }), true)).toEqual(["light"]);
  expect(bootstrap(JSON.stringify({ state: { theme: "system" } }), false)).toEqual(["light"]);
  expect(bootstrap(JSON.stringify({ state: { theme: "system" } }), true)).toEqual(["dark"]);
});
