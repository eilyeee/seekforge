import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
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
    .describe("What to ask about the image (default: a detailed description)."),
});

const DEFAULT_QUESTION = "Describe this image in detail for a coding agent.";

const imageAnalyze = defineTool({
  name: "image_analyze",
  description:
    "Analyze an image file (png/jpg/jpeg/gif/webp, max 4MB) with the configured vision model and return a text description. " +
    "Use it to read screenshots, diagrams, or UI mockups. Requires user confirmation (network call).",
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
      bytes = fs.readFileSync(resolved);
    } catch (err) {
      throw new ToolError(
        "read_failed",
        `Cannot read image ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ToolError(
        "too_large",
        `Image is ${bytes.length} bytes; max is ${MAX_IMAGE_BYTES} (4MB)`,
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
    const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ToolError(
        "vision_failed",
        `Vision request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new ToolError("vision_failed", `Vision API returned HTTP ${res.status}`);
    }
    const json = (await res.json().catch(() => undefined)) as
      | { choices?: { message?: { content?: unknown } }[] }
      | undefined;
    const description = json?.choices?.[0]?.message?.content;
    if (typeof description !== "string" || description.length === 0) {
      throw new ToolError("vision_failed", "Vision API response had no message content");
    }

    return { data: { description } };
  },
});

export const visionTools: ToolSpec[] = [imageAnalyze];
