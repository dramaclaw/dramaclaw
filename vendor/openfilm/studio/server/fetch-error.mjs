// @ts-check
/** Why fetching a film failed (fetch-repo.mjs, fetch-github.mjs). */
export class FetchError extends Error {
  /**
   * `code`, for the editor's own words: url, host, ref, access, network, git, no-folder, no-film, no-skill, too-big, timeout,
   * cancelled, failed; 'use-git' only between the two modules (GitHub's API cannot list it, git is tried).
   * @param {string} message @param {number} [status] @param {string} [code]
   */
  constructor(message, status = 400, code = 'failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
