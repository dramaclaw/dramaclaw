// Starts the vendored OpenFilm Studio for Dramaclaw and announces where it listens.
// Python owns the lifecycle: it picks the port, the key, OPENFILM_HOME and reads the
// single JSON line below. Keep stdout to that line; Studio logs go to stderr.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { startStudio } from "../../vendor/openfilm/studio/server/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const port = Number(process.env.OPENFILM_STUDIO_PORT || 4747);
const key = process.env.OPENFILM_STUDIO_KEY || "";
const home = process.env.OPENFILM_HOME || "";
const editorDir = process.env.OPENFILM_STUDIO_EDITOR_DIR || resolve(repoRoot, "vendor/openfilm/studio/ui/dist");

/* Hosted editor guards, forced rather than inherited: a deployment that forgets an env var
   would otherwise leave them open or put host state and caches on object storage.
   - `/api/update` runs `npx -y openfilm@latest update`, rewriting vendor/openfilm — this launcher,
     the vendored server and Dramaclaw's patched chunk included — and running upstream code on the host.
   - `PATCH /api/projects/:id` moves the project folder, and the host looks a film up by that folder's
     name — its node id — so a rename quietly orphans the cut inside it.
   - the boot-time examples index is fetched from GitHub, so a shared server would phone home for every
     tenant that opens the editor.
   - every film must register its host state and runtime directories. */
process.env.OPENFILM_NO_UPDATE_CHECK = "1";
process.env.OPENFILM_NO_RENAME = "1";
process.env.OPENFILM_NO_EXAMPLES = "1";
process.env.OPENFILM_HOST_DIRS = "1";

if (!key || !home) {
  console.error(`${!key ? "OPENFILM_STUDIO_KEY" : "OPENFILM_HOME"} is required`);
  process.exit(2);
}

mkdirSync(home, { recursive: true, mode: 0o700 });
const pidFile = resolve(home, "studio.pid");
const ourPid = String(process.pid);
const removePid = () => {
  try {
    if (readFileSync(pidFile, "utf8").trim() === ourPid) unlinkSync(pidFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const pidAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
};

// All contenders use exclusive creation, including after discarding a stale pid.
for (;;) {
  try {
    writeFileSync(pidFile, `${ourPid}\n`, { flag: "wx", mode: 0o600 });
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid;
    try {
      pid = Number(readFileSync(pidFile, "utf8").trim());
    } catch (readError) {
      if (readError.code === "ENOENT") continue;
      throw readError;
    }
    if (pidAlive(pid)) {
      console.error(`another Studio is running on this home (pid ${pid})`);
      process.exit(3);
    }
    try {
      unlinkSync(pidFile);
    } catch (unlinkError) {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    }
  }
}
process.on("exit", removePid);

let studio;
const stop = async () => {
  await studio?.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  studio = await startStudio({ port, key, advertise: false, editorDir, onQuit: stop });
} catch (error) {
  console.error(String(error?.stack || error));
  process.exit(1);
}

const where = { origin: studio.origin, filmOrigin: studio.filmOrigin, port: studio.port };
process.stdout.write(`${JSON.stringify(where)}\n`);
if (process.env.OPENFILM_STUDIO_READY_FILE) {
  writeFileSync(process.env.OPENFILM_STUDIO_READY_FILE, `${JSON.stringify(where)}\n`, { mode: 0o600 });
}
