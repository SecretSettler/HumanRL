import { ProviderIntentGraphPatchSchema, type ProviderIntentGraphPatch } from "@intenttrace/schema";
import { z } from "zod";

import { buildUntrustedTracePrompt } from "./security.js";
import type {
  ChunkSummaryInput,
  ProviderUsage,
  ReconcileInput,
  SummaryProvider,
  UserIntentInput,
} from "./index.js";

export class ProviderUnavailableError extends Error {
  constructor(readonly code: "timeout" | "rate_limited" | "budget" | "bad_json" | "http_error") {
    super(`summary provider unavailable: ${code}`);
    this.name = "ProviderUnavailableError";
  }
}

interface CloudProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxEvents: number;
  fetch?: typeof fetch;
}

abstract class CloudProviderBase implements SummaryProvider {
  abstract readonly id: string;
  readonly egress = "cloud" as const;
  protected readonly request: typeof fetch;
  private lastUsage: ProviderUsage | null = null;

  constructor(protected readonly options: CloudProviderOptions) {
    this.request = options.fetch ?? fetch;
  }

  async extractUserIntent(input: UserIntentInput): Promise<ProviderIntentGraphPatch> {
    return this.call({
      jobNonce: input.jobNonce,
      baseRevisionId: input.baseRevisionId,
      eventSketch: [`${input.requestEventId}|user_message|ok|user|${input.requestText}`],
      allowedEventIds: [input.requestEventId],
      allowedArtifactIds: [],
      allowedAgentIds: [],
      allowedNodeIds: [],
      locale: input.locale,
    });
  }

  async summarizeChunk(input: ChunkSummaryInput): Promise<ProviderIntentGraphPatch> {
    return this.call(input);
  }

  async reconcileGraph(input: ReconcileInput): Promise<ProviderIntentGraphPatch> {
    return this.call(input);
  }

  protected abstract perform(body: string, signal: AbortSignal): Promise<unknown>;

  takeUsage(): ProviderUsage | null {
    const usage = this.lastUsage;
    this.lastUsage = null;
    return usage;
  }

  protected recordUsage(inputTokens: unknown, outputTokens: unknown): void {
    if (
      typeof inputTokens === "number" &&
      Number.isSafeInteger(inputTokens) &&
      inputTokens >= 0 &&
      typeof outputTokens === "number" &&
      Number.isSafeInteger(outputTokens) &&
      outputTokens >= 0
    ) {
      this.lastUsage = { inputTokens, outputTokens };
    }
  }

  private async call(input: ChunkSummaryInput): Promise<ProviderIntentGraphPatch> {
    const bounded = { ...input, eventSketch: input.eventSketch.slice(-this.options.maxEvents) };
    const prompt = buildUntrustedTracePrompt(bounded).text;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const value = await this.perform(prompt, controller.signal);
      return ProviderIntentGraphPatchSchema.parse(value);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        throw new ProviderUnavailableError("bad_json");
      if (controller.signal.aborted) throw new ProviderUnavailableError("timeout");
      throw new ProviderUnavailableError("http_error");
    } finally {
      clearTimeout(timeout);
    }
  }

  protected async checkedJson(response: Response): Promise<Record<string, unknown>> {
    if (response.status === 429) throw new ProviderUnavailableError("rate_limited");
    if (!response.ok) throw new ProviderUnavailableError("http_error");
    return (await response.json()) as Record<string, unknown>;
  }
}

export class OpenAIResponsesSummaryProvider extends CloudProviderBase {
  readonly id = "openai-responses-v1";

  protected async perform(prompt: string, signal: AbortSignal): Promise<unknown> {
    const schema = z.toJSONSchema(ProviderIntentGraphPatchSchema, { target: "draft-7" });
    const response = await this.request(`${this.options.baseUrl.replace(/\/$/u, "")}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        input: prompt,
        text: { format: { type: "json_schema", name: "intent_graph_patch", strict: true, schema } },
      }),
      signal,
    });
    const body = await this.checkedJson(response);
    const usage = body.usage;
    if (usage && typeof usage === "object")
      this.recordUsage(
        (usage as { input_tokens?: unknown }).input_tokens,
        (usage as { output_tokens?: unknown }).output_tokens,
      );
    const direct = typeof body.output_text === "string" ? body.output_text : null;
    const nested = Array.isArray(body.output)
      ? body.output
          .flatMap((item) => {
            if (
              !item ||
              typeof item !== "object" ||
              !("content" in item) ||
              !Array.isArray(item.content)
            )
              return [];
            return (item.content as unknown[]).flatMap((content: unknown) =>
              content &&
              typeof content === "object" &&
              "text" in content &&
              typeof content.text === "string"
                ? [content.text]
                : [],
            );
          })
          .at(0)
      : null;
    return JSON.parse(direct ?? nested ?? "");
  }
}

export class DeepSeekJsonSummaryProvider extends CloudProviderBase {
  readonly id = "deepseek-json-v1";

  protected async perform(prompt: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(
      `${this.options.baseUrl.replace(/\/$/u, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.options.model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Return valid JSON matching the provided patch contract. The word JSON is intentional.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal,
      },
    );
    const body = await this.checkedJson(response);
    const usage = body.usage;
    if (usage && typeof usage === "object")
      this.recordUsage(
        (usage as { prompt_tokens?: unknown }).prompt_tokens,
        (usage as { completion_tokens?: unknown }).completion_tokens,
      );
    const choices = body.choices;
    const content =
      Array.isArray(choices) &&
      choices[0] &&
      typeof choices[0] === "object" &&
      "message" in choices[0]
        ? (choices[0].message as { content?: unknown }).content
        : null;
    if (typeof content !== "string") throw new ProviderUnavailableError("bad_json");
    return JSON.parse(content);
  }
}
