const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const https = require("node:https");

/**
 * A minimal RFC 6455 client with the surface the bridge uses from `ws`
 * (`on('open'|'message'|'error'|'close')`, `send(text)`, `close()`).
 *
 * The extension ships unbundled and the release VSIX is packaged with
 * `vsce --no-dependencies`, which leaves node_modules out, and the Node inside
 * VS Code 1.95 has no global WebSocket. A client with no dependency is the one
 * that is certain to be there.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
/** Largest message accepted from the server; the server's own frames are far smaller. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 1_000;

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const length = body.length;
  const lengthBytes = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  if (lengthBytes === 0) header[1] = 0x80 | length;
  else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  // Client frames are always masked (RFC 6455 §5.3).
  const mask = crypto.randomBytes(4);
  mask.copy(header, 2 + lengthBytes);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, masked]);
}

class ProtocolError extends Error {}

/**
 * Parses as many complete frames as `buffer` holds. Returns the frames and the
 * unconsumed remainder; throws ProtocolError on anything a server may not send.
 */
function decodeFrames(buffer, maxBytes = MAX_MESSAGE_BYTES) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    if (first & 0x70) throw new ProtocolError("reserved bits set");
    if (second & 0x80) throw new ProtocolError("server frames must not be masked");
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(maxBytes)) throw new ProtocolError("frame too large");
      length = Number(big);
      header = 10;
    }
    if (length > maxBytes) throw new ProtocolError("frame too large");
    if (opcode >= 0x8 && (!fin || length > 125)) throw new ProtocolError("invalid control frame");
    if (buffer.length - offset < header + length) break;
    frames.push({ fin, opcode, payload: buffer.subarray(offset + header, offset + header + length) });
    offset += header + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class WebSocketClient extends EventEmitter {
  constructor(address, { maxMessageBytes = MAX_MESSAGE_BYTES, headers = {} } = {}) {
    super();
    const url = new URL(address);
    if (url.protocol !== "ws:" && url.protocol !== "wss:")
      throw new Error(`Unsupported WebSocket URL: ${url.protocol}`);
    this.maxMessageBytes = maxMessageBytes;
    this.readyState = "connecting";
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.fragmentBytes = 0;
    this.closeEmitted = false;
    this.socket = undefined;

    const key = crypto.randomBytes(16).toString("base64");
    const request = (url.protocol === "wss:" ? https : http).request({
      protocol: url.protocol === "wss:" ? "https:" : "http:",
      hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port || (url.protocol === "wss:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
    this.request = request;
    request.on("upgrade", (response, socket, head) => {
      const expected = crypto.createHash("sha1").update(`${key}${GUID}`).digest("base64");
      if (response.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        this.fail(new Error("Invalid Sec-WebSocket-Accept header"));
        return;
      }
      if (this.readyState !== "connecting") {
        socket.destroy();
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on("data", (chunk) => this.receive(chunk));
      socket.on("error", (error) => this.fail(error));
      socket.on("close", () => this.finish());
      this.readyState = "open";
      this.emit("open");
      if (head?.length) this.receive(head);
    });
    request.on("response", (response) => {
      response.resume();
      this.fail(new Error(`Unexpected server response: ${response.statusCode}`));
    });
    request.on("error", (error) => this.fail(error));
    request.end();
  }

  receive(chunk) {
    if (this.readyState === "closed") return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let decoded;
    try {
      decoded = decodeFrames(this.buffer, this.maxMessageBytes);
    } catch (error) {
      this.protocolFailure(error);
      return;
    }
    this.buffer = Buffer.from(decoded.rest);
    for (const frame of decoded.frames) {
      if (this.readyState === "closed") return;
      this.handleFrame(frame);
    }
  }

  handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODES.text:
      case OPCODES.binary:
        if (this.fragments) return this.protocolFailure(new ProtocolError("new message inside a fragmented one"));
        if (fin) {
          this.emit("message", Buffer.from(payload), opcode === OPCODES.binary);
          return;
        }
        this.fragments = { opcode, parts: [Buffer.from(payload)] };
        this.fragmentBytes = payload.length;
        return;
      case OPCODES.continuation: {
        if (!this.fragments) return this.protocolFailure(new ProtocolError("unexpected continuation frame"));
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxMessageBytes)
          return this.protocolFailure(new ProtocolError("message too large"));
        this.fragments.parts.push(Buffer.from(payload));
        if (!fin) return;
        const { opcode: kind, parts } = this.fragments;
        this.fragments = null;
        this.fragmentBytes = 0;
        this.emit("message", Buffer.concat(parts), kind === OPCODES.binary);
        return;
      }
      case OPCODES.ping:
        this.write(OPCODES.pong, Buffer.from(payload));
        return;
      case OPCODES.pong:
        return;
      case OPCODES.close:
        if (this.readyState === "open") {
          this.readyState = "closing";
          this.write(OPCODES.close, payload.length >= 2 ? Buffer.from(payload.subarray(0, 2)) : Buffer.alloc(0));
        }
        this.socket?.end();
        return;
      default:
        this.protocolFailure(new ProtocolError(`unknown opcode ${opcode}`));
    }
  }

  write(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(encodeFrame(opcode, payload));
    return true;
  }

  send(data) {
    if (this.readyState !== "open") throw new Error("WebSocket is not open");
    this.write(OPCODES.text, typeof data === "string" ? data : Buffer.from(data));
  }

  close(code = 1000) {
    if (this.readyState === "closed" || this.readyState === "closing") return;
    if (this.readyState === "connecting") {
      this.readyState = "closing";
      this.request.destroy();
      this.finish();
      return;
    }
    this.readyState = "closing";
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.write(OPCODES.close, payload);
    this.socket.end();
    // A server that never answers the close handshake still gets disconnected.
    const timer = setTimeout(() => this.socket?.destroy(), CLOSE_TIMEOUT_MS);
    timer.unref?.();
    this.socket.once("close", () => clearTimeout(timer));
  }

  protocolFailure(error) {
    // 1002 protocol error, sent before the socket is torn down.
    this.write(OPCODES.close, Buffer.from([0x03, 0xea]));
    this.fail(error);
  }

  fail(error) {
    if (this.readyState === "closed") return;
    if (this.listenerCount("error") > 0) this.emit("error", error);
    this.request.destroy();
    this.socket?.destroy();
    this.finish();
  }

  finish() {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = "closed";
    this.emit("close");
  }
}

module.exports = { MAX_MESSAGE_BYTES, ProtocolError, WebSocketClient, decodeFrames, encodeFrame };
