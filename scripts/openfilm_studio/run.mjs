// Starts the vendored OpenFilm Studio for Dramaclaw and announces where it listens.
// Python owns the lifecycle: it picks the port, the key, OPENFILM_HOME and reads the
// single JSON line below. Keep stdout to that line; Studio logs go to stderr.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { startStudio } from "../../vendor/openfilm/studio/server/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const port = Number(process.env.OPENFILM_STUDIO_PORT || 4747);
const key = process.env.OPENFILM_STUDIO_KEY || "";
const editorDir = process.env.OPENFILM_STUDIO_EDITOR_DIR || resolve(repoRoot, "vendor/openfilm/studio/ui/dist");

if (!key) {
  console.error("OPENFILM_STUDIO_KEY is required");
  process.exit(2);
}

let studio;
try {
  studio = await startStudio({
    port,
    key,
    advertise: false,
    editorDir,
    onQuit: async () => {
      await studio?.close();
      process.exit(0);
    },
  });
} catch (error) {
  console.error(String(error?.stack || error));
  process.exit(1);
}

const where = { origin: studio.origin, filmOrigin: studio.filmOrigin, port: studio.port };
process.stdout.write(`${JSON.stringify(where)}\n`);
if (process.env.OPENFILM_STUDIO_READY_FILE) {
  writeFileSync(process.env.OPENFILM_STUDIO_READY_FILE, `${JSON.stringify(where)}\n`, { mode: 0o600 });
}

const stop = async () => {
  await studio?.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
