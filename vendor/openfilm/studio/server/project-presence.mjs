// @ts-check
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { FILM_FILE } from '../../src/film-doc.mjs';

/**
 * A project needs both its folder and its film file. Contents are checked by the editor separately: an empty or
 * unfinished film is still a file the person or agent can fix. Nothing is created while checking presence.
 * @param {string} root @returns {'folder' | 'film' | undefined}
 */
export function projectMissing(root) {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return 'folder';
  if (!statSync(join(root, FILM_FILE), { throwIfNoEntry: false })?.isFile()) return 'film';
  return undefined;
}
