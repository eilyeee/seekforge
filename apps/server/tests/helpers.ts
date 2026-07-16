import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import type { AgentEvent } from "@seekforge/shared";
import type { RunAgentTaskInput } from "@seekforge/core";
import type { LoopOptions, LoopResult } from "@seekforge/core";
import type { CreateAgentFn, CreateAgentOptions, ResumeLoopFn, RunLoopFn } from "../src/index.js";

/** Creates a throwaway workspace directory (vitest cleans tmpdir lazily). */
export function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "seekforge-server-"));
}

export function writeFileIn(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export type FakeRun = (opts: CreateAgentOptions, input: RunAgentTaskInput) => AsyncIterable<AgentEvent>;

/** Agent factory whose runTask is a scripted async generator. */
export function fakeAgentFactory(run: FakeRun): CreateAgentFn {
  return (opts) => ({
    agent: { runTask: (input) => run(opts, input) },
    dispose: () => {},
  });
}

/** A fake factory for tests that never start a run. */
export const unusedAgentFactory: CreateAgentFn = () => {
  throw new Error("createAgent must not be called in this test");
};

/** A fake loop runner for tests that never start a loop. */
export const unusedLoopFactory: RunLoopFn = () => {
  throw new Error("runLoop must not be called in this test");
};

export type FakeLoop = (opts: CreateAgentOptions, loopOpts: LoopOptions) => Promise<LoopResult>;

/** Builds a RunLoopFn from a scripted async loop body. */
export function fakeLoopFactory(loop: FakeLoop): RunLoopFn {
  return loop;
}

export const unusedResumeLoopFactory: ResumeLoopFn = () => {
  throw new Error("resumeLoop must not be called in this test");
};

/**
 * Fake factory that records every runTask input into `inputs` and finishes
 * immediately (for asserting pass-through of start/send frame fields).
 */
export function recordingAgentFactory(inputs: RunAgentTaskInput[]): CreateAgentFn {
  return fakeAgentFactory(async function* (_opts, input) {
    inputs.push(input);
    yield { type: "session.created", sessionId: input.resumeSessionId ?? "rec-1" };
    yield { type: "session.completed", report: emptyReport() };
  });
}

export function emptyReport(summary = "done") {
  return {
    summary,
    changedFiles: [],
    commandsRun: [],
    verification: "no commands were run",
    usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
  };
}

export function connectWs(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

export type Frame = Record<string, unknown> & { type: string };

export type FrameCollector = {
  frames: Frame[];
  /** Waits for (and consumes everything up to) the next frame matching pred. */
  waitFor(pred: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
};

export function collectFrames(ws: WebSocket): FrameCollector {
  const frames: Frame[] = [];
  let cursor = 0;
  const wakers: (() => void)[] = [];
  ws.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as Frame);
    for (const wake of wakers.splice(0)) wake();
  });
  return {
    frames,
    async waitFor(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (cursor < frames.length) {
          const frame = frames[cursor++]!;
          if (pred(frame)) return frame;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for frame; received: ${JSON.stringify(frames)}`);
        }
        await new Promise<void>((resolve) => {
          wakers.push(resolve);
          setTimeout(resolve, 25);
        });
      }
    },
  };
}

/** Polls until cond() is true (for observing fake-agent side effects). */
export async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
