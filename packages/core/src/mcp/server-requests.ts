import { pathToFileURL } from "node:url";
import { isRecord } from "../util/guards.js";

/**
 * Requests that travel the other way: server → client.
 *
 * Almost all of MCP is the client asking a server for something. Three methods
 * go the other way, and each one asks for something the server cannot get by
 * itself: the workspace layout (`roots/list`), the user's model
 * (`sampling/createMessage`), or the user's own answer (`elicitation/create`).
 *
 * Both transports — stdio and Streamable HTTP — receive these, so the decision
 * of what to answer lives here rather than twice. Two rules hold throughout:
 * a capability is advertised ONLY when a handler is actually wired, so a server
 * never asks for something that will be refused; and every field arriving from
 * a server is validated before it reaches a model or a person.
 */

/** Cap what a server can push into a sampling request. */
const MAX_SAMPLING_MESSAGES = 50;
const MAX_SAMPLING_CHARS = 200_000;
const MAX_SYSTEM_PROMPT_CHARS = 20_000;
const MAX_ELICITATION_MESSAGE_CHARS = 4_000;
const MAX_ELICITATION_FIELDS = 20;
/**
 * Requests a server may have in flight against us at once. Sampling and
 * elicitation each occupy a person or a paid model call until they resolve, so
 * a server that fires them in a loop would otherwise queue an unbounded pile of
 * prompts. roots/list is exempt: it answers immediately from local state.
 */
const MAX_INFLIGHT_SERVER_REQUESTS = 4;

// JSON-RPC error codes used in replies to a server.
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export type SamplingMessage = { role: "user" | "assistant"; text: string };

export type SamplingRequest = {
  server: string;
  messages: SamplingMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  /** Model hints the server suggested, in preference order. Advisory only. */
  modelHints?: string[];
};

export type SamplingResult = {
  text: string;
  model: string;
  stopReason?: string;
};

export type ElicitationField = {
  name: string;
  /** JSON Schema primitive: string | number | integer | boolean. */
  type: string;
  title?: string;
  description?: string;
  /** Closed set of allowed values, when the schema declares an enum. */
  options?: string[];
  required: boolean;
};

export type ElicitationRequest = {
  server: string;
  message: string;
  fields: ElicitationField[];
};

export type ElicitationResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

export type SamplingHandler = (request: SamplingRequest, signal?: AbortSignal) => Promise<SamplingResult>;
export type ElicitationHandler = (request: ElicitationRequest, signal?: AbortSignal) => Promise<ElicitationResult>;

export type McpServerRequestHandlers = {
  /** Answers `sampling/createMessage` by running the user's own model. */
  sampling?: SamplingHandler;
  /** Answers `elicitation/create` by asking the user. */
  elicitation?: ElicitationHandler;
};

/**
 * Capabilities advertised in `initialize`. Roots are always supported; the two
 * that need a human or a model are advertised only when the caller wired one,
 * so a server can tell what is actually available instead of discovering it
 * through a refusal.
 */
export function clientCapabilities(handlers?: McpServerRequestHandlers): Record<string, unknown> {
  return {
    roots: { listChanged: true },
    ...(handlers?.sampling ? { sampling: {} } : {}),
    ...(handlers?.elicitation ? { elicitation: {} } : {}),
  };
}

/** Builds the roots/list reply payload from the configured workspace paths. */
export function buildRootsResult(workspaceRoots: string[] | undefined): {
  roots: Array<{ uri: string; name?: string }>;
} {
  return { roots: (workspaceRoots ?? []).map((p) => ({ uri: pathToFileURL(p).href, name: "workspace" })) };
}

class InvalidServerRequest extends Error {}

function invalid(message: string): never {
  throw new InvalidServerRequest(message);
}

/** Flatten MCP content (text parts only) — a sampling prompt is text here. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : [content];
  const text = parts
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  return text;
}

export function parseSamplingRequest(server: string, params: unknown): SamplingRequest {
  if (!isRecord(params)) invalid("sampling/createMessage params must be an object");
  const rawMessages = params.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    invalid("sampling/createMessage requires a non-empty messages array");
  }
  if (rawMessages.length > MAX_SAMPLING_MESSAGES) {
    invalid(`sampling/createMessage may not send more than ${MAX_SAMPLING_MESSAGES} messages`);
  }
  const messages: SamplingMessage[] = [];
  let total = 0;
  for (const raw of rawMessages) {
    if (!isRecord(raw)) invalid("every sampling message must be an object");
    const role = raw.role;
    if (role !== "user" && role !== "assistant") invalid('sampling message role must be "user" or "assistant"');
    const text = contentText(raw.content);
    if (!text) invalid("every sampling message needs text content (only text parts are supported)");
    total += text.length;
    if (total > MAX_SAMPLING_CHARS) invalid(`sampling/createMessage exceeds ${MAX_SAMPLING_CHARS} characters`);
    messages.push({ role, text });
  }

  const systemPrompt = typeof params.systemPrompt === "string" ? params.systemPrompt : undefined;
  if (systemPrompt !== undefined && systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    invalid(`sampling systemPrompt exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters`);
  }
  const maxTokens =
    typeof params.maxTokens === "number" && Number.isFinite(params.maxTokens) && params.maxTokens > 0
      ? Math.floor(params.maxTokens)
      : undefined;
  const hints = isRecord(params.modelPreferences) ? params.modelPreferences.hints : undefined;
  const modelHints = Array.isArray(hints)
    ? hints
        .map((hint) => (isRecord(hint) && typeof hint.name === "string" ? hint.name : ""))
        .filter(Boolean)
        .slice(0, 5)
    : undefined;

  return {
    server,
    messages,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(modelHints && modelHints.length > 0 ? { modelHints } : {}),
  };
}

/**
 * Parse `elicitation/create`. The spec restricts the schema to a flat object of
 * primitives, which is what makes it safe to render as a prompt; anything
 * nested is rejected rather than flattened into something the user did not see.
 */
export function parseElicitationRequest(server: string, params: unknown): ElicitationRequest {
  if (!isRecord(params)) invalid("elicitation/create params must be an object");
  const message = params.message;
  if (typeof message !== "string" || message.trim() === "") invalid("elicitation/create requires a message");
  if (message.length > MAX_ELICITATION_MESSAGE_CHARS) {
    invalid(`elicitation message exceeds ${MAX_ELICITATION_MESSAGE_CHARS} characters`);
  }
  const schema = params.requestedSchema;
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
    invalid("elicitation/create requires a requestedSchema of type object with properties");
  }
  const properties = schema.properties as Record<string, unknown>;
  const names = Object.keys(properties);
  if (names.length === 0) invalid("elicitation requestedSchema has no properties");
  if (names.length > MAX_ELICITATION_FIELDS) {
    invalid(`elicitation requestedSchema may not ask for more than ${MAX_ELICITATION_FIELDS} fields`);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : []);

  const fields: ElicitationField[] = names.map((name) => {
    const property = properties[name];
    if (!isRecord(property)) invalid(`elicitation field ${name} must be a schema object`);
    const type = property.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
      invalid(`elicitation field ${name} must be a primitive (string, number, integer or boolean)`);
    }
    const options = Array.isArray(property.enum)
      ? property.enum.map((value) => String(value)).slice(0, MAX_ELICITATION_FIELDS)
      : undefined;
    return {
      name,
      type,
      ...(typeof property.title === "string" ? { title: property.title } : {}),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      ...(options && options.length > 0 ? { options } : {}),
      required: required.has(name),
    };
  });

  return { server, message, fields };
}

export type JsonRpcReply =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number; error: { code: number; message: string } };

export type ServerRequestResponderOptions = {
  /** Server name, for messages the user sees. */
  name: string;
  workspaceRoots?: string[];
  handlers?: McpServerRequestHandlers;
};

/**
 * Build the reply to one server→client request. Never throws: a handler that
 * fails becomes a JSON-RPC error, because leaving the server without an answer
 * stalls it until its own timeout.
 */
export function createServerRequestResponder(
  options: ServerRequestResponderOptions,
): (id: string | number, method: string, params: unknown, signal?: AbortSignal) => Promise<JsonRpcReply> {
  let inflight = 0;
  return async (id, method, params, signal) => {
    const ok = (result: unknown): JsonRpcReply => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string): JsonRpcReply => ({ jsonrpc: "2.0", id, error: { code, message } });

    if (method === "roots/list") return ok(buildRootsResult(options.workspaceRoots));

    if (inflight >= MAX_INFLIGHT_SERVER_REQUESTS) {
      return err(
        INTERNAL_ERROR,
        `too many concurrent requests from this server (limit ${MAX_INFLIGHT_SERVER_REQUESTS}); retry when one completes`,
      );
    }

    if (method === "sampling/createMessage") {
      const handler = options.handlers?.sampling;
      if (!handler) return err(METHOD_NOT_FOUND, "method not found: sampling/createMessage");
      let request: SamplingRequest;
      try {
        request = parseSamplingRequest(options.name, params);
      } catch (error) {
        return err(INVALID_PARAMS, error instanceof Error ? error.message : String(error));
      }
      inflight++;
      try {
        const result = await handler(request, signal);
        return ok({
          role: "assistant",
          content: { type: "text", text: result.text },
          model: result.model,
          ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        });
      } catch (error) {
        return err(INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      } finally {
        inflight--;
      }
    }

    if (method === "elicitation/create") {
      const handler = options.handlers?.elicitation;
      if (!handler) return err(METHOD_NOT_FOUND, "method not found: elicitation/create");
      let request: ElicitationRequest;
      try {
        request = parseElicitationRequest(options.name, params);
      } catch (error) {
        return err(INVALID_PARAMS, error instanceof Error ? error.message : String(error));
      }
      inflight++;
      try {
        const result = await handler(request, signal);
        return ok(
          result.action === "accept" ? { action: "accept", content: result.content } : { action: result.action },
        );
      } catch (error) {
        return err(INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      } finally {
        inflight--;
      }
    }

    return err(METHOD_NOT_FOUND, `method not found: ${method}`);
  };
}
