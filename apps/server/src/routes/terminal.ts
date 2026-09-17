/**
 * Terminal availability for the Desktop panel. The terminal itself is a
 * WebSocket (/ws/terminal, see terminal.ts); this route lets a client decide
 * whether to offer it before opening one.
 */

import { sendJson } from "../http.js";
import { terminalAvailability } from "../terminal.js";
import type { RouteCtx } from "./context.js";

export async function handle(ctx: RouteCtx): Promise<boolean> {
  const path = ctx.url.pathname;
  if (ctx.method === "GET" && path === "/api/terminal") {
    sendJson(ctx.res, 200, { ...terminalAvailability(ctx.rest.terminalEnabled !== false), cwd: ctx.workspace });
    return true;
  }
  return false;
}
