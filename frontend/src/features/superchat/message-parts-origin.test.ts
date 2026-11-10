import { expect, it } from "vitest";
import { localSnapshot, markLocalMessageChanges } from "./message-parts-origin";
import type { ChatMessage, ChatScope } from "./types";
const scope: ChatScope = { kind: "home" };
const history: ChatMessage = { id: "m", role: "assistant", turnId: "t", text: "old", timestamp: 1 };
it("history has no write intent and cached local messages lose their intent", () => {
  expect(localSnapshot(history)).toBeUndefined();
  const [live] = markLocalMessageChanges([history], [{ ...history, text: "new" }], scope, "home");
  expect(localSnapshot(live)?.text).toBe("new");
  expect(localSnapshot(JSON.parse(JSON.stringify(live)))).toBeUndefined();
  expect(localSnapshot(history)).toBeUndefined();
});
it("a replay retaining a live message does not mutate its snapshot or captured scope", () => {
  const [live] = markLocalMessageChanges([history], [{ ...history, text: "new" }], scope, "home");
  const snapshot = localSnapshot(live);
  const replay = { ...live, text: "server history", timestamp: 2 };
  expect(localSnapshot(replay)).toBe(snapshot);
  expect(snapshot).toMatchObject({ text: "new", scope, scopeKey: "home" });
  const [unchanged] = markLocalMessageChanges([live], [{ ...live, timestamp: 3 }], scope, "home");
  expect(localSnapshot(unchanged)).toBe(snapshot);
});
