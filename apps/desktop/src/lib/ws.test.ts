import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WS_PAYLOAD_BYTES } from "@seekforge/shared/protocol-limits";
import { createWsClient, encodeClientFrame } from "./ws";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.onclose?.();
  }
}

describe("createWsClient reconnect queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost" } });
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not replay a queued request after its connection fails", () => {
    const states: string[] = [];
    const client = createWsClient({
      getToken: () => "",
      onState: (state) => states.push(state),
      onFrame: vi.fn(),
    });
    expect(client.send({ type: "cancel" })).toBe(true);

    FakeWebSocket.instances[0]!.onclose?.();
    expect(client.send({ type: "cancel" })).toBe(false);
    vi.advanceTimersByTime(500);
    const replacement = FakeWebSocket.instances[1]!;
    replacement.readyState = FakeWebSocket.OPEN;
    replacement.onopen?.();

    expect(replacement.sent).toEqual([]);
    expect(states).toContain("disconnected");
    client.close();
  });

  it("rejects frames above the server payload limit before sending", () => {
    const client = createWsClient({ getToken: () => "", onState: vi.fn(), onFrame: vi.fn() });
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    const frame = {
      type: "start",
      task: "x".repeat(MAX_WS_PAYLOAD_BYTES),
      mode: "edit",
      approvalMode: "confirm",
    } as const;
    expect(encodeClientFrame(frame)).toBeNull();
    expect(client.send(frame)).toBe(false);
    expect(socket.sent).toEqual([]);
    client.close();
  });
});
