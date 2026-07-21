import * as path from "node:path";
import { z } from "zod";
import { onAbortOnce } from "../../util/abort.js";
import { readResponseBody } from "../../util/response-body.js";
import { FileTooLargeError, readFileBoundedSync } from "../../util/fs.js";
import { ToolError } from "../errors.js";
import { resolveForRead } from "../sandbox.js";
import { defineTool, type ToolSpec } from "../registry.js";

const VISION_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB — data-URL payloads beyond this get rejected upstream anyway
const MAX_OUTPUT_TOKENS = 1000;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Vision-model endpoint used by image_analyze. Any OpenAI-compatible
 * /chat/completions endpoint that accepts image_url content parts works
 * (DeepSeek currently has no vision model, so this is typically a separate
 * provider/key from the main agent model).
 */
export type VisionConfig = {
  /** Vision-capable model id, e.g. "gpt-4o-mini" or "qwen-vl-plus". */
  model: string;
  /** OpenAI-compatible base URL (no trailing /chat/completions). */
  baseUrl: string;
  /** Bearer token; omit for keyless local endpoints. */
  apiKey?: string;
};

// Module-level seam: ToolContext deliberately carries no provider credentials
// (tools must not see API keys), so apps inject the vision endpoint once at
// assembly time instead. configureVision(null) disables the tool again.
let visionConfig: VisionConfig | null = null;

/**
 * Configures the vision endpoint for the image_analyze builtin. Call once at
 * app assembly time (before the first tool run); pass null to disable.
 * Unconfigured, image_analyze fails with code "vision_unconfigured".
 */
export function configureVision(config: VisionConfig | null): void {
  visionConfig = config;
}

const imageAnalyzeSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Image file to analyze (png/jpg/jpeg/gif/webp), workspace-relative or an absolute path inside the workspace.",
    ),
  question: z
    .string()
    .optional()
    .describe('Specific question about the image, e.g. "What error is shown?" (default: a detailed description).'),
});

const DEFAULT_QUESTION = "Describe this image in detail for a coding agent.";

const imageAnalyze = defineTool({
  name: "image_analyze",
  description:
    "Send the image at path (png/jpg/jpeg/gif/webp, max 4MB) to the configured vision model and return a text answer; fails with vision_unconfigured when no vision model is set up. " +
    'Ask a specific question ("What error text is shown in this screenshot?", "List the form fields and their labels") rather than a generic one. ' +
    "Network call — always requires user confirmation.",
  schema: imageAnalyzeSchema,
  // "env" level: always confirmed, even in auto-approval mode — same pattern
  // as web_fetch/web_search; the image leaves the machine via a network call.
  classify: (args) => ({
    permission: "env",
    description: `Analyze image: ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    if (!visionConfig) {
      throw new ToolError("vision_unconfigured", "set visionModel in config to enable image analysis");
    }
    const { model, baseUrl, apiKey } = visionConfig;

    const ext = path.extname(args.path).toLowerCase();
    const mime = MIME_BY_EXTENSION[ext];
    if (!mime) {
      throw new ToolError(
        "unsupported_image",
        `Unsupported image extension "${ext || "(none)"}" — supported: png, jpg, jpeg, gif, webp`,
      );
    }

    // resolveForRead handles both workspace-relative and absolute paths and
    // rejects anything that escapes the workspace (symlinks included).
    const resolved = resolveForRead(ctx.workspace, args.path);
    let bytes: Buffer;
    try {
      bytes = readFileBoundedSync(resolved, MAX_IMAGE_BYTES);
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        throw new ToolError("too_large", `Image exceeds ${MAX_IMAGE_BYTES} bytes (4MB): ${args.path}`);
      }
      throw new ToolError(
        "read_failed",
        `Cannot read image ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const question = args.question ?? DEFAULT_QUESTION;
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    const body = {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
    };

    const controller = new AbortController();
    const offAbort = onAbortOnce(ctx.signal, () => controller.abort());
    const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
    let description: string;
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new ToolError("vision_failed", `Vision API returned HTTP ${res.status}`);
      }
      const responseBytes = await readResponseBody(res);
      let json: { choices?: { message?: { content?: unknown } }[] } | undefined;
      try {
        json = JSON.parse(responseBytes.toString("utf8")) as typeof json;
      } catch {
        json = undefined;
      }
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new ToolError("vision_failed", "Vision API response had no message content");
      }
      description = content;
    } catch (err) {
      if (ctx.signal?.aborted) throw new ToolError("cancelled", "Vision request cancelled");
      if (err instanceof ToolError) throw err;
      throw new ToolError(
        "vision_failed",
        `Vision request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      offAbort();
      clearTimeout(timer);
    }

    return { data: { description } };
  },
});

export const visionTools: ToolSpec[] = [imageAnalyze];
