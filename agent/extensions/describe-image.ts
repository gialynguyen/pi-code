import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { uuidv7 } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve, extname } from "node:path";

// Default vision model configuration. Tunable via describe-image.json next to
// this file. All keys are optional; missing values fall back to the defaults below.
type DescribeImageConfig = {
  provider: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
};

const DEFAULT_PROMPT =
  "Describe this image in detail. Transcribe any visible text exactly, preserving structure and order. Then describe layout, UI elements, colors, and notable features. Note anything unclear or cut off.";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export default function (pi: ExtensionAPI) {
  // Load config once, synchronously at load time. Falls back to {} on any error
  // or missing file, then merges with defaults.
  const configPath = resolve(__dirname, "describe-image.json");
  let fileConfig: Record<string, unknown> = {};
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fileConfig = parsed as Record<string, unknown>;
      }
    }
  } catch {
    fileConfig = {};
  }

  const cfg: DescribeImageConfig = {
    provider: typeof fileConfig.provider === "string" ? fileConfig.provider : "opencode-go",
    model: typeof fileConfig.model === "string" ? fileConfig.model : "minimax-m3",
    prompt: typeof fileConfig.prompt === "string" ? fileConfig.prompt : DEFAULT_PROMPT,
    reasoningEffort: typeof fileConfig.reasoningEffort === "string" ? fileConfig.reasoningEffort : undefined,
  };

  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description:
      "Read an image file from disk and return a text description from a vision model. Use when you cannot see images directly (for example, when images.blockImages is on). Supports png, jpg, jpeg, gif, webp, bmp. Parameters: path (absolute or relative to the current working directory), prompt (optional question or instruction about the image).",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the image file, absolute or relative to the current working directory.",
      }),
      prompt: Type.Optional(
        Type.String({
          description:
            "Optional question or instruction about the image, e.g. 'What does the error say?' or 'Describe the layout'.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const cwd = (ctx as { cwd: string }).cwd;
      const abs = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);

      // Read the image from disk (bypassing images.blockImages, which strips
      // image payloads from the built-in read tool).
      let buf: Buffer;
      try {
        buf = await readFile(abs);
      } catch {
        return {
          content: [{ type: "text" as const, text: "Image file not found or unreadable: " + abs }],
          details: {},
        };
      }

      const b64 = buf.toString("base64");
      const ext = extname(abs).slice(1).toLowerCase();
      const mimeType = MIME[ext] ?? "image/png";

      // Resolve the vision model through pi's already-authenticated providers.
      const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
      if (!model) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Vision model not found in registry: " + cfg.provider + "/" + cfg.model,
            },
          ],
          details: {},
        };
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No authentication configured for vision model: " + cfg.provider + "/" + cfg.model,
            },
          ],
          details: {},
        };
      }

      // pi-ai normalized ImageContent: base64 data with no data: prefix and no
      // source/media_type wrapper.
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: params.prompt ?? cfg.prompt },
            { type: "image", data: b64, mimeType },
          ],
        },
      ];

      const opts: Record<string, unknown> = { signal, cacheRetention: "none", sessionId: uuidv7() };
      if (cfg.reasoningEffort) opts.reasoningEffort = cfg.reasoningEffort;

      try {
        const response = await ctx.modelRegistry.complete(model, { messages }, opts);
        const text =
          (response.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => (c as { text?: string }).text ?? "")
            .join("\n")
            .trim() || "(no response)";
        return {
          content: [{ type: "text" as const, text }],
          details: { usedModel: cfg.provider + "/" + cfg.model, imagePath: abs },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Vision model call failed: " + (err instanceof Error ? err.message : String(err)),
            },
          ],
          details: {},
        };
      }
    },
  });
}