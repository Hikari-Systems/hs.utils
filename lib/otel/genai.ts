/**
 * One span and a set of metrics per generative-AI call, the same shape
 * whichever provider or SDK makes it, under the OpenTelemetry GenAI semantic
 * conventions where they exist (`gen_ai.*`) and `hs.gen_ai.*` where they have
 * nothing.
 *
 * Name the purpose, never the data: `task`, `result` and the error type are
 * metric labels, constants from code. Never put a prompt, a reply or a user
 * id on this span.
 */
import {
  Attributes,
  Span,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from '@opentelemetry/api';
import { MAX_ATTR_LEN, truncate } from './common';
import { recordGenAi } from './metrics';
import { tracer } from './state';

/** `gen_ai.provider.name` values. */
export const GENAI_PROVIDER = {
  AWS_BEDROCK: 'aws.bedrock',
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  GCP_GEMINI: 'gcp.gemini',
  MISTRAL_AI: 'mistral_ai',
  DEEPSEEK: 'deepseek',
  /** Not in the conventions: OpenRouter, whatever model it routes to. */
  OPENROUTER: 'openrouter',
  /** Not in the conventions: a local or self-hosted Ollama. */
  OLLAMA: 'ollama',
} as const;

/** `gen_ai.operation.name` values. */
export const GENAI_OPERATION = {
  CHAT: 'chat',
  TEXT_COMPLETION: 'text_completion',
  GENERATE_CONTENT: 'generate_content',
  EMBEDDINGS: 'embeddings',
  INVOKE_AGENT: 'invoke_agent',
} as const;

/** What a finished call reported. Providers differ in what they send. */
export interface GenAiUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens served from the prompt cache (counted in `inputTokens`). */
  cacheReadInputTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheCreationInputTokens?: number;
  /** The provider's stop reason as it sends it. */
  finishReason?: string;
  /** The model that answered, when it differs from the one requested. */
  responseModel?: string;
  /** The provider's own latency figure, in seconds, when it sends one. */
  providerLatencySecs?: number;
  /** What the provider says the call cost, in USD, when it reports one. */
  costUsd?: number;
  /** The host a router picked to serve the call. Span only. */
  upstreamProvider?: string;
}

/** The timing figures for one call. */
export interface GenAiTimings {
  total: number;
  ingestion?: number;
  generation?: number;
  tokensPerSecond?: number;
}

export const genAiTimings = (
  totalSecs: number,
  firstChunkSecs: number | undefined,
  outputTokens: number | undefined,
): GenAiTimings => {
  const ingestion = firstChunkSecs;
  const generation =
    ingestion === undefined ? undefined : Math.max(totalSecs - ingestion, 0);
  // Generation time for a stream; the whole call otherwise (and for a stream
  // whose first chunk was also its last).
  const denom =
    generation !== undefined && generation > 0 ? generation : totalSecs;
  const tokensPerSecond =
    outputTokens !== undefined && outputTokens > 0 && denom > 0
      ? outputTokens / denom
      : undefined;
  return { total: totalSecs, ingestion, generation, tokensPerSecond };
};

/**
 * One GenAI call in flight. Create it just before the request, run the
 * request inside {@link GenAiCall.span} (or {@link GenAiCall.run}), then
 * {@link GenAiCall.finish} or {@link GenAiCall.fail} it, and {@link
 * GenAiCall.end} it once the reply has been dealt with (an `end` without
 * either records `error.type = cancelled`). The metrics are recorded at
 * `end`: `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`,
 * `gen_ai.client.operation.time_to_first_chunk` (streams),
 * `hs.gen_ai.client.output_throughput` and `hs.gen_ai.client.cost`.
 *
 * ```ts
 * const call = GenAiCall.start(GENAI_OPERATION.CHAT, GENAI_PROVIDER.OPENAI, model, 'chat.turn', false);
 * try {
 *   const r = await call.run(() => client.chat(...));
 *   call.finish({ inputTokens: r.usage.input, outputTokens: r.usage.output });
 * } catch (e) {
 *   call.fail('http.429');
 *   throw e;
 * } finally {
 *   call.end();
 * }
 * ```
 */
export class GenAiCall {
  readonly span: Span;

  private readonly started = performance.now();

  private firstChunkSecs?: number;

  private done = false;

  private ended = false;

  private metrics: {
    errorType?: string;
    inputTokens?: number;
    outputTokens?: number;
    timings?: GenAiTimings;
    costUsd?: number;
  } = {};

  private constructor(
    private readonly operation: string,
    private readonly provider: string,
    private readonly model: string,
    private readonly task: string,
    private readonly streaming: boolean,
  ) {
    this.span = tracer().startSpan(`${operation} ${model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'gen_ai.operation.name': operation,
        'gen_ai.provider.name': provider,
        'gen_ai.request.model': truncate(model, MAX_ATTR_LEN),
        'gen_ai.request.stream': streaming,
        'hs.gen_ai.task': task,
      },
    });
  }

  /**
   * Start timing a call. `operation` and `provider` are from
   * {@link GENAI_OPERATION} / {@link GENAI_PROVIDER}; `model` is the
   * requested model id; `task` is a constant naming what the call is for.
   */
  static start(
    operation: string,
    provider: string,
    model: string,
    task: string,
    streaming: boolean,
  ): GenAiCall {
    return new GenAiCall(operation, provider, model, task, streaming);
  }

  private secs(): number {
    return (performance.now() - this.started) / 1000;
  }

  /** Run `fn` with this call's span active, so transport spans nest here. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(
      context.with(trace.setSpan(context.active(), this.span), fn),
    );
  }

  /** The request's output-token cap. */
  maxTokens(n: number): void {
    this.span.setAttribute('gen_ai.request.max_tokens', n);
  }

  /** The first content chunk of a stream arrived. Only the first counts. */
  firstChunk(): void {
    if (this.streaming && this.firstChunkSecs === undefined)
      this.firstChunkSecs = this.secs();
  }

  private recordTimings(t: GenAiTimings): void {
    const s = this.span;
    s.setAttribute('hs.gen_ai.duration_s', t.total);
    if (t.ingestion !== undefined) {
      s.setAttribute('gen_ai.response.time_to_first_chunk', t.ingestion);
      s.setAttribute('hs.gen_ai.ingestion_s', t.ingestion);
    }
    if (t.generation !== undefined)
      s.setAttribute('hs.gen_ai.generation_s', t.generation);
    if (t.tokensPerSecond !== undefined)
      s.setAttribute('hs.gen_ai.output_tokens_per_second', t.tokensPerSecond);
  }

  /** The response is complete. A second `finish`, or `fail` after it, is ignored. */
  finish(usage: GenAiUsage): void {
    if (this.done) return;
    this.done = true;
    const t = genAiTimings(
      this.secs(),
      this.streaming ? this.firstChunkSecs : undefined,
      usage.outputTokens,
    );
    const a: Attributes = {};
    const label = (v: string) => truncate(v, MAX_ATTR_LEN);
    if (usage.inputTokens !== undefined)
      a['gen_ai.usage.input_tokens'] = usage.inputTokens;
    if (usage.outputTokens !== undefined)
      a['gen_ai.usage.output_tokens'] = usage.outputTokens;
    if (usage.cacheReadInputTokens !== undefined)
      a['gen_ai.usage.cache_read.input_tokens'] = usage.cacheReadInputTokens;
    if (usage.cacheCreationInputTokens !== undefined)
      a['gen_ai.usage.cache_creation.input_tokens'] =
        usage.cacheCreationInputTokens;
    if (usage.finishReason !== undefined)
      a['gen_ai.response.finish_reasons'] = label(usage.finishReason);
    if (usage.responseModel !== undefined)
      a['gen_ai.response.model'] = label(usage.responseModel);
    if (usage.providerLatencySecs !== undefined)
      a['hs.gen_ai.provider_latency_s'] = usage.providerLatencySecs;
    const cost =
      usage.costUsd !== undefined && Number.isFinite(usage.costUsd)
        ? usage.costUsd
        : undefined;
    if (cost !== undefined) a['hs.gen_ai.cost_usd'] = cost;
    if (usage.upstreamProvider !== undefined)
      a['hs.gen_ai.upstream_provider'] = label(usage.upstreamProvider);
    this.span.setAttributes(a);
    this.recordTimings(t);
    this.span.addEvent('gen_ai call finished', {
      ...a,
      'hs.gen_ai.duration_s': t.total,
    });
    this.metrics = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      timings: t,
      costUsd: cost,
    };
  }

  /**
   * The call failed. `errorType` is a low-cardinality constant (`timeout`,
   * `throttled`, `http.429` …), never the error's message. Ignored after
   * {@link finish}.
   */
  fail(errorType: string): void {
    if (this.done) return;
    this.done = true;
    const t = genAiTimings(this.secs(), undefined, undefined);
    this.recordTimings(t);
    this.span.setAttribute('error.type', errorType);
    this.span.setStatus({ code: SpanStatusCode.ERROR });
    this.span.addEvent('gen_ai call failed', {
      'error.type': errorType,
      'hs.gen_ai.duration_s': t.total,
    });
    this.metrics = { errorType, timings: t };
  }

  /** The caller's verdict on the reply (`ok`, `empty`, `unparseable` …). */
  result(verdict: string): void {
    this.span.setAttribute('hs.gen_ai.result', verdict);
  }

  /**
   * End the span and record the metrics. Without `finish` or `fail` first,
   * the call is recorded as `error.type = cancelled`. Idempotent.
   */
  end(): void {
    if (this.ended) return;
    if (!this.done) this.fail('cancelled');
    this.ended = true;
    const m = this.metrics;
    recordGenAi({
      operation: this.operation,
      provider: this.provider,
      model: this.model,
      task: this.task,
      stream: this.streaming,
      errorType: m.errorType,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      durationS: m.timings?.total ?? this.secs(),
      ttftS: m.timings?.ingestion,
      tokensPerSecond: m.timings?.tokensPerSecond,
      costUsd: m.costUsd,
    });
    this.span.end();
  }
}
