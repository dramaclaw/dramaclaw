/**
 * Frontend mirror of the backend task-scope hashing in
 * `novelvideo/task_identity.py` + `novelvideo/task_scopes.py`.
 *
 * The backend derives a task's `scope` as:
 *   hashed_scope(label, json.dumps(config, sort_keys=True,
 *                                  ensure_ascii=False, separators=(",", ":")))
 *   -> `${label}__${sha1(payloadUtf8).hex.slice(0, 12)}`
 *
 * `useTaskController` reconciles a card against the live `/tasks` list by
 * comparing `key.scope` to the row's stored `scope`. That stored scope is the
 * hashed value above, so the FE reconcile key MUST reproduce the exact same
 * hash — a human-readable placeholder like `scene:大学宿舍:pano` never matches,
 * which silently drops the loading state after a refresh.
 */

/** Synchronous SHA-1 over raw bytes, returning lowercase hex. */
function sha1Hex(bytes: Uint8Array): string {
  const withOne = bytes.length + 1;
  const totalLen = withOne + (((56 - (withOne % 64)) + 64) % 64) + 8;
  const msg = new Uint8Array(totalLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;

  const dv = new DataView(msg.buffer);
  const bitLen = bytes.length * 8;
  dv.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(totalLen - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < totalLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const hex = (n: number) => `0000000${(n >>> 0).toString(16)}`.slice(-8);
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/**
 * Canonical JSON matching Python's
 * `json.dumps(config, sort_keys=True, ensure_ascii=False, separators=(",", ":"))`.
 * Keys are sorted; `JSON.stringify` on each string yields the same escaping and
 * keeps non-ASCII characters raw (matching `ensure_ascii=False`).
 */
function canonicalJson(config: Record<string, string>): string {
  const keys = Object.keys(config).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(config[k])}`);
  return `{${parts.join(",")}}`;
}

/** Mirror of `task_config_scope(label, config)`. */
export function taskConfigScope(label: string, config: Record<string, string>): string {
  const payload = new TextEncoder().encode(canonicalJson(config));
  return `${label}__${sha1Hex(payload).slice(0, 12)}`;
}

/** Mirror of `scene_reference_asset_scope` — kinds: "master", "reverse". */
export function sceneReferenceAssetScope(sceneName: string, kind: string): string {
  return taskConfigScope("scene_ref", { scene: sceneName, kind });
}

/**
 * Mirror of `stage_asset_scope` — steps: "pano_from_master", "pano_from_text",
 * "single_face_sharp", "pano_sharp".
 */
export function stageAssetScope(sceneName: string, step: string): string {
  return taskConfigScope("stage_asset", { scene: sceneName, step });
}

/** Mirror of `prop_reference_asset_scope`. */
export function propReferenceAssetScope(propName: string): string {
  return taskConfigScope("prop_ref", { prop: propName });
}
