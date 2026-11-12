// Development-only incident replay. Not imported by the product entrypoint.
import { createRoot } from "react-dom/client";
import { useSuperChat } from "../use-superchat";
import "@/i18n";
function Harness() {
  const chat = useSuperChat({ project: "oom-replay", displayName: "OOM replay", surface: "freezone", freezoneCanvasId: "replay", freezoneAgentId: "main" });
  const thoughts = chat.messages.flatMap(message => message.parts ?? []).filter(part => part.type === "agent_thought");
  const characters = thoughts.reduce((count, part) => count + ("event" in part ? String((part.event as { text?: string }).text ?? "").length : 0), 0);
  return <main><h1>OOM incident replay</h1><pre id="state">{JSON.stringify({ connected: chat.connected, busy: chat.busy, characters, messages: chat.messages.length, error: chat.error })}</pre>
    <button onClick={() => void fetch('/api/v1/replay/start', { method: 'POST' })}>Replay thought stream</button>
    <button onClick={() => void fetch('/api/v1/replay/disconnect', { method: 'POST' })}>Disconnect</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
