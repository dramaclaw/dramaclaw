// @ts-check
/**
 * Move a file or folder to the system's trash, so a person can take it back from there: Studio never deletes media
 * outright (a file the film no longer uses is in no version of the project's history, so a delete would be for good).
 *
 *   macOS    the system's own `trash` (macOS 15 and later): the Trash of the file's disk, with Put Back, and allowed
 *            where moving into ~/.Trash is not (a program without Full Disk Access); before it, ~/.Trash (with " 2",
 *            " 3" on a name already there)
 *   Linux    the freedesktop trash: ~/.local/share/Trash/{files,info}, with the .trashinfo that lets it be restored
 *   Windows  the Recycle Bin, through PowerShell
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
/** macOS's own command for the Trash (macOS 15 and later). */
const MAC_TRASH = '/usr/bin/trash';

/** A name in `dir` that is free: `name`, else `name 2.ext`, `name 3.ext`… */
function freeName(/** @type {string} */ dir, /** @type {string} */ name) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; existsSync(join(dir, candidate)); n++) candidate = `${stem} ${n}${ext}`;
  return candidate;
}

/** @param {string} path an absolute path */
export async function moveToTrash(path) {
  /* tests (and anyone who wants deletes kept elsewhere) name the folder that stands for the trash */
  if (process.env.OPENFILM_TRASH_DIR) {
    const dir = process.env.OPENFILM_TRASH_DIR;
    await mkdir(dir, { recursive: true });
    await rename(path, join(dir, freeName(dir, basename(path))));
    return;
  }
  if (process.platform === 'win32') {
    const kind = (await import('node:fs')).statSync(path).isDirectory() ? 'DeleteDirectory' : 'DeleteFile';
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}($env:OPENFILM_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, OPENFILM_TRASH: path }, windowsHide: true });
    return;
  }
  if (process.platform === 'darwin' && existsSync(MAC_TRASH)) {
    await run(MAC_TRASH, [path]);
    return;
  }
  if (process.platform === 'darwin') {
    const dir = join(homedir(), '.Trash');
    await mkdir(dir, { recursive: true });
    try { await rename(path, join(dir, freeName(dir, basename(path)))); }
    catch (e) {
      /* on another disk the file belongs in that disk's own trash, which the Finder knows */
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EXDEV') throw e;
      await run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', path]);
    }
    return;
  }
  const root = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const files = join(root, 'Trash', 'files');
  const info = join(root, 'Trash', 'info');
  await mkdir(files, { recursive: true });
  await mkdir(info, { recursive: true });
  const name = freeName(files, basename(path));
  await writeFile(join(info, `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
  await rename(path, join(files, name));
}
