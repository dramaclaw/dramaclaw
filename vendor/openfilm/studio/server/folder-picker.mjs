// @ts-check
/**
 * The system's own folder and file dialogs, opened by Studio for a page in a browser (which can never learn a path):
 * the export's "Save to", and the media pane's "Import" and "Link" (pickFiles). The desktop app opens its own folder
 * dialog instead (lib/host.ts `folders.pick`).
 *
 *   macOS     osascript, `choose folder` / `choose file`, asked of Finder: a dialog of osascript's own opens behind
 *             the browser (macOS lets no background program bring itself forward), so it seems nothing happened. The
 *             first time, macOS asks once to let Studio's program control Finder; the app that was in front comes back
 *             when the dialog closes.
 *   Windows   PowerShell, the Windows Forms folder / file dialog
 *   Linux     zenity, else kdialog
 *
 * The page's words and the folder it starts in reach the dialog as arguments or environment variables, never inside
 * the script, so nothing typed can run as code.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/**
 * osascript's lines (`-e` each) for a dialog Finder opens in front, `lines` setting `picked`; the app that was in
 * front is brought back after, picked or not. @param {string[]} lines
 */
function finderDialog(lines) {
  return [
    'on run argv',
    'set frontApp to (path to frontmost application as text)',
    /* the folder to start in, made here: Finder can't make a path one (-1700), and one that is gone opens none */
    'set startAt to missing value',
    'if (item 2 of argv) is not "" then',
    'try',
    'set startAt to (POSIX file (item 2 of argv)) as alias',
    'end try',
    'end if',
    'try',
    'tell application "Finder"',
    'activate',
    ...lines,
    'end tell',
    'on error message number n',
    'tell application frontApp to activate',
    'error message number n',
    'end try',
    'tell application frontApp to activate',
    'return picked',
    'end run',
  ].flatMap((line) => ['-e', line]);
}

/**
 * How to open the dialog here: the program, its arguments and the environment it adds; null when this system has none.
 * @param {NodeJS.Platform} platform @param {{ title: string, at?: string | null }} ask @param {(name: string) => boolean} [has]
 * @returns {{ cmd: string, args: string[], env?: Record<string, string> } | null}
 */
export function folderPickerCommand(platform, { title, at }, has = () => true) {
  const start = at && isAbsolute(at) ? at : '';
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [...finderDialog([
        'if startAt is missing value then',
        'set picked to POSIX path of (choose folder with prompt (item 1 of argv))',
        'else',
        'set picked to POSIX path of (choose folder with prompt (item 1 of argv) default location startAt)',
        'end if',
      ]), title, start],
    };
  }
  if (platform === 'win32') {
    const script = [
      // Match execFile's UTF-8 decoding, including paths outside the Windows console code page.
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $env:OPENFILM_PICK_TITLE',
      '$d.UseDescriptionForTitle = $true',
      'if ($env:OPENFILM_PICK_AT) { $d.SelectedPath = $env:OPENFILM_PICK_AT }',
      '$w = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      'if ($d.ShowDialog($w) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script], env: { OPENFILM_PICK_TITLE: title, OPENFILM_PICK_AT: start } };
  }
  if (has('zenity')) {
    return { cmd: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start}/`] : [])] };
  }
  if (has('kdialog')) return { cmd: 'kdialog', args: ['--getexistingdirectory', start || '.', '--title', title] };
  return null;
}

/**
 * How to open the dialog that picks files (several at once): the program, its arguments and the environment it adds;
 * null when this system has none. It prints one path a line.
 * @param {NodeJS.Platform} platform @param {{ title: string, at?: string | null }} ask @param {(name: string) => boolean} [has]
 * @returns {{ cmd: string, args: string[], env?: Record<string, string> } | null}
 */
export function filePickerCommand(platform, { title, at }, has = () => true) {
  const start = at && isAbsolute(at) ? at : '';
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [...finderDialog([
        'if startAt is missing value then',
        'set chosen to choose file with prompt (item 1 of argv) with multiple selections allowed',
        'else',
        'set chosen to choose file with prompt (item 1 of argv) default location startAt with multiple selections allowed',
        'end if',
        'set picked to ""',
        'repeat with f in chosen',
        'set picked to picked & POSIX path of f & linefeed',
        'end repeat',
      ]), title, start],
    };
  }
  if (platform === 'win32') {
    const script = [
      // Match execFile's UTF-8 decoding, including paths outside the Windows console code page.
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      '$d.Title = $env:OPENFILM_PICK_TITLE',
      '$d.Multiselect = $true',
      'if ($env:OPENFILM_PICK_AT) { $d.InitialDirectory = $env:OPENFILM_PICK_AT }',
      '$w = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      'if ($d.ShowDialog($w) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($d.FileNames -join "`n")) }',
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script], env: { OPENFILM_PICK_TITLE: title, OPENFILM_PICK_AT: start } };
  }
  if (has('zenity')) {
    return { cmd: 'zenity', args: ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`, ...(start ? [`--filename=${start}/`] : [])] };
  }
  if (has('kdialog')) return { cmd: 'kdialog', args: ['--getopenfilename', start || '.', '--multiple', '--separate-output', '--title', title] };
  return null;
}

/**
 * Whether a dialog that gave nothing was cancelled: osascript says error -128 (any other error exits 1 too: Finder
 * not allowed, -1743, is a failure, and the page lets the person type the path), zenity and kdialog exit 1, Windows
 * prints nothing. @param {string} cmd @param {import('node:child_process').ExecFileException | null} error
 */
export function cancelled(cmd, error) {
  if (!error) return true;
  if (/-128\b|User canceled/i.test(String(error.message))) return true;
  return cmd !== 'osascript' && error.code === 1;
}

/**
 * Where a dialog starts: the folder asked, or the nearest folder above it that is there (an exports folder is made
 * by the first export); none when nothing of it is. @param {string | null | undefined} at
 * @param {(path: string) => boolean} [exists]
 */
export function startFolder(at, exists = existsSync) {
  if (!at || !isAbsolute(at)) return null;
  for (let dir = at; ; dir = dirname(dir)) {
    if (exists(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** Whether a program is on the PATH (Linux: which dialog there is). @param {string} name */
const onPath = (name) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(`${dir}/${name}`));

/**
 * Ask the person for a folder. Resolves its path, or null when they cancelled; rejects when this system has no dialog
 * Studio can open (the page lets them type one then).
 * @param {{ title: string, at?: string | null }} ask @returns {Promise<string | null>}
 */
export function pickFolder(ask) {
  const command = folderPickerCommand(process.platform, { ...ask, at: startFolder(ask.at) }, onPath);
  if (!command) return Promise.reject(new Error('no folder dialog on this system'));
  return new Promise((resolve, reject) => {
    execFile(command.cmd, command.args, { env: { ...process.env, ...command.env }, encoding: 'utf8', windowsHide: false, timeout: 15 * 60_000 }, (error, stdout) => {
      const path = String(stdout).trim().replace(/[\\/]+$/, '') || (String(stdout).trim() === '/' ? '/' : '');
      if (path) { resolve(path); return; }
      if (cancelled(command.cmd, error)) { resolve(null); return; }
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') { reject(new Error('no folder dialog on this system')); return; }
      reject(error);
    });
  });
}

/**
 * Ask the person for files. Resolves their paths (none when they cancelled); rejects when this system has no dialog
 * Studio can open.
 * @param {{ title: string, at?: string | null }} ask @returns {Promise<string[]>}
 */
export function pickFiles(ask) {
  const command = filePickerCommand(process.platform, { ...ask, at: startFolder(ask.at) }, onPath);
  if (!command) return Promise.reject(new Error('no file dialog on this system'));
  return new Promise((resolve, reject) => {
    execFile(command.cmd, command.args, { env: { ...process.env, ...command.env }, encoding: 'utf8', windowsHide: false, timeout: 15 * 60_000 }, (error, stdout) => {
      const paths = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && isAbsolute(line));
      if (paths.length) { resolve(paths); return; }
      if (cancelled(command.cmd, error)) { resolve([]); return; }
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') { reject(new Error('no file dialog on this system')); return; }
      reject(error);
    });
  });
}
