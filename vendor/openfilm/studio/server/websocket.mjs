// @ts-check
/**
 * A WebSocket that tells (RFC 6455, server to page): the editor pages' streams of events. Not a stream over HTTP: a
 * browser keeps at most six HTTP connections to one host, and a few open pages each holding their streams there would
 * leave none for the requests the pages make. WebSockets are not counted in those six.
 *
 * Text frames out, a ping every 15 s. From the page: control frames (a close is answered, a ping ponged) and short
 * texts (whether the page is in sight). A frame from the page larger than MAX_FRAME closes the socket: it is never held
 * whole.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** The most a frame from the page may carry. It sends control frames and short texts; a little room beyond. */
export const MAX_FRAME = 1 << 20;

/** A frame: `opcode` with `payload`, unmasked (a server never masks). @param {number} opcode @param {Buffer} payload */
function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/**
 * Answer an upgrade request (`req`, its `socket`) as a WebSocket; returns how to send an event (as JSON), or null
 * when the request is not a WebSocket's (it was answered 400). `onClose` runs once, when the page goes; `onText` with
 * each text the page sends (a text split over frames is not read: the pages send short ones whole).
 * @param {import('node:http').IncomingMessage} req @param {import('node:stream').Duplex} socket @param {() => void} onClose
 * @param {(text: string) => void} [onText]
 * @returns {((event: unknown) => void) | null}
 */
export function acceptWebSocket(req, socket, onClose, onText) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let closed = false;
  const ping = setInterval(() => { if (!closed) socket.write(frame(0x9, Buffer.alloc(0))); }, 15_000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    onClose();
  };
  /* what the page sends: control frames and short texts, possibly split across chunks */
  let pending = Buffer.alloc(0);
  socket.on('data', (/** @type {Buffer} */ chunk) => {
    if (closed) return;
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f, fin = (pending[0] & 0x80) !== 0, masked = (pending[1] & 0x80) !== 0;
      let n = pending[1] & 0x7f, at = 2;
      if (n === 126) { if (pending.length < 4) return; n = pending.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (pending.length < 10) return; n = Number(pending.readBigUInt64BE(2)); at = 10; }
      /* too big: closed (1009, message too big) and nothing more read, the bytes it says follow never waited for */
      if (n > MAX_FRAME) {
        pending = Buffer.alloc(0);
        socket.end(frame(0x8, Buffer.from([0x03, 0xf1])));
        close();
        setTimeout(() => socket.destroy(), 1000).unref();
        return;
      }
      const mask = masked ? pending.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (pending.length < at + n) return;
      const payload = Buffer.from(pending.subarray(at, at + n));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      pending = pending.subarray(at + n);
      if (opcode === 0x8) { if (!closed) socket.end(frame(0x8, payload.subarray(0, 2))); close(); return; }
      if (opcode === 0x9 && !closed) socket.write(frame(0xa, payload));
      if (opcode === 0x1 && fin) onText?.(payload.toString('utf8'));
    }
  });
  socket.on('close', close);
  socket.on('error', close);
  return (event) => { if (!closed) socket.write(frame(0x1, Buffer.from(JSON.stringify(event)))); };
}
