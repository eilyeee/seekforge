const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const { WebSocketServer } = require("ws");
const { SeekForgeBridge } = require("../src/bridge.cjs");
const { ProtocolError, WebSocketClient, decodeFrames, encodeFrame } = require("../src/websocket-client.cjs");

/** A real `ws` server on an ephemeral loopback port — the library the SeekForge server itself uses. */
async function wsServer(t, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, ...options });
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

function nextMessage(socket) {
  return new Promise((resolve) =>
    socket.once("message", (data, isBinary) => resolve({ text: String(data), isBinary })),
  );
}

test("exchanges text frames of every length encoding in both directions", { timeout: 10_000 }, async (t) => {
  const { server, url } = await wsServer(t);
  const received = [];
  server.on("connection", (peer) => {
    peer.on("message", (data) => {
      received.push(String(data));
      peer.send(String(data).toUpperCase());
    });
  });
  const client = new WebSocketClient(url);
  await once(client, "open");
  for (const size of [0, 5, 125, 126, 65_535, 65_536, 200_000]) {
    const text = "é".repeat(Math.floor(size / 2)) + "x".repeat(size % 2);
    const reply = nextMessage(client);
    client.send(text);
    assert.equal((await reply).text, text.toUpperCase(), `size ${size}`);
  }
  assert.equal(received.length, 7);
  client.close();
  await once(client, "close");
});

test("reassembles fragmented messages and answers pings", { timeout: 10_000 }, async (t) => {
  const { server, url } = await wsServer(t);
  const pongs = [];
  server.on("connection", (peer) => {
    peer.on("pong", (data) => pongs.push(String(data)));
    peer.ping("are you there");
    peer.send("hel", { fin: false });
    peer.send("lo ", { fin: false });
    peer.send("world", { fin: true });
  });
  const client = new WebSocketClient(url);
  const message = await nextMessage(client);
  assert.deepEqual(message, { text: "hello world", isBinary: false });
  const deadline = Date.now() + 2_000;
  while (pongs.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(pongs, ["are you there"]);
  client.close();
  await once(client, "close");
});

test("a server-initiated close ends the connection once", { timeout: 10_000 }, async (t) => {
  const { server, url } = await wsServer(t);
  server.on("connection", (peer) => peer.close(1000, "bye"));
  const client = new WebSocketClient(url);
  let closes = 0;
  client.on("close", () => {
    closes += 1;
  });
  await once(client, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closes, 1);
  assert.throws(() => client.send("late"), /not open/);
});

test("a rejected upgrade reports the status the bridge classifies as unauthorized", { timeout: 10_000 }, async (t) => {
  const { url } = await wsServer(t, { verifyClient: (_info, done) => done(false, 401, "Unauthorized") });
  const client = new WebSocketClient(`${url}/ws?token=wrong`);
  // The error and the close are emitted together; listen for both first
  // (`events.once` would reject the close wait on the error itself).
  const closed = new Promise((resolve) => client.once("close", resolve));
  const [error] = await once(client, "error");
  assert.match(error.message, /Unexpected server response: 401/);
  await closed;
});

test("an upgrade with the wrong accept key is refused", { timeout: 10_000 }, async (t) => {
  const server = http.createServer();
  server.on("upgrade", (_req, socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bm9wZQ==\r\n\r\n",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const client = new WebSocketClient(`ws://127.0.0.1:${server.address().port}`);
  const [error] = await once(client, "error");
  assert.match(error.message, /Sec-WebSocket-Accept/);
});

test("a masked or reserved-bit frame from the server is a protocol error", { timeout: 10_000 }, async (t) => {
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    const accept = crypto
      .createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // A client-style (masked) frame is never valid from a server.
    socket.write(encodeFrame(0x1, "sneaky"));
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const client = new WebSocketClient(`ws://127.0.0.1:${server.address().port}`);
  const [error] = await once(client, "error");
  assert.ok(error instanceof ProtocolError);
  assert.match(error.message, /must not be masked/);
});

test("frame decoding waits for complete frames and enforces limits", { timeout: 10_000 }, () => {
  const text = Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]);
  assert.deepEqual(decodeFrames(text.subarray(0, 3)).frames, []);
  const { frames, rest } = decodeFrames(Buffer.concat([text, text.subarray(0, 1)]));
  assert.equal(frames.length, 1);
  assert.equal(String(frames[0].payload), "abc");
  assert.equal(rest.length, 1);
  const huge = Buffer.from([0x82, 0x7f, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.throws(() => decodeFrames(huge, 1024), /too large/);
  assert.throws(() => decodeFrames(Buffer.from([0x09, 0x00])), /invalid control frame/);
  assert.throws(() => decodeFrames(Buffer.from([0xc1, 0x00])), /reserved bits/);
  // Client frames carry a mask key and masked bytes.
  const encoded = encodeFrame(0x1, "hi");
  assert.equal(encoded[1] & 0x80, 0x80);
  assert.equal(encoded.length, 2 + 4 + 2);
});

test("a message larger than the limit closes the connection", { timeout: 10_000 }, async (t) => {
  const { server, url } = await wsServer(t);
  server.on("connection", (peer) => peer.send("x".repeat(2_000)));
  const client = new WebSocketClient(url, { maxMessageBytes: 1_000 });
  const [error] = await once(client, "error");
  assert.match(error.message, /too large/);
});

test("the bridge runs a whole session over this client", { timeout: 10_000 }, async (t) => {
  const { server, url } = await wsServer(t);
  const frames = [];
  server.on("connection", (peer, request) => {
    assert.equal(request.url, "/ws?token=secret");
    peer.send(JSON.stringify({ type: "hello", protocolVersion: 1 }));
    peer.on("message", (data) => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.type === "start") {
        peer.send(JSON.stringify({ type: "run.accepted", runId: "run-1", status: "queued", seq: 1 }));
        peer.send(JSON.stringify({ type: "permission.request", requestId: "p1", request: { description: "x" } }));
      }
      if (frame.type === "permission.response") {
        peer.send(JSON.stringify({ type: "event", event: { type: "model.message", content: "done" } }));
        peer.send(JSON.stringify({ type: "idle" }));
      }
    });
  });
  const bridge = new SeekForgeBridge({
    serverUrl: url.replace("ws:", "http:"),
    token: "secret",
    WebSocketImpl: WebSocketClient,
  });
  const seen = [];
  await bridge.run({ type: "start", task: "hi", mode: "ask", approvalMode: "confirm" }, async (message, reply) => {
    seen.push(message.type);
    if (message.type === "permission.request") {
      reply({ type: "permission.response", requestId: message.requestId, approved: false, feedback: "no" });
    }
  });
  assert.deepEqual(seen, ["hello", "run.accepted", "permission.request", "event", "idle"]);
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["start", "permission.response"],
  );
  assert.equal(frames[1].feedback, "no");
});

test("cancelling before the socket opens closes it without sending", { timeout: 10_000 }, async (t) => {
  const { url } = await wsServer(t);
  const bridge = new SeekForgeBridge({
    serverUrl: url.replace("ws:", "http:"),
    token: "",
    WebSocketImpl: WebSocketClient,
  });
  const controller = new AbortController();
  const running = bridge.run({ type: "start", task: "x" }, async () => {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, (error) => error.name === "AbortError");
});

test("a refused connection surfaces the network error code", { timeout: 10_000 }, async () => {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const client = new WebSocketClient(`ws://127.0.0.1:${port}`);
  const [error] = await once(client, "error");
  assert.equal(error.code, "ECONNREFUSED");
  assert.throws(() => new WebSocketClient("http://127.0.0.1:1"), /Unsupported WebSocket URL/);
});
