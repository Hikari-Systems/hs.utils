import {
  Span,
  SpanKind,
  SpanStatusCode,
  context,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';
import { MAX_ATTR_LEN, truncate, unsampledContext } from './common';
import { recordClientOperation } from './metrics';
import { Level, isExported, tracer } from './state';

/**
 * Systems whose calls are database calls in the semantic conventions, so
 * they also get `db.system.name` / `db.operation.name`.
 */
const DB_SYSTEMS = ['redis', 'postgresql'];

interface ClientInfo {
  system: string;
  operation: string;
  outcome?: string;
  ended: boolean;
}

const info = new WeakMap<Span, ClientInfo>();

/** Spans whose kind of "failed" event is that of an HTTP client span. */
const httpSpans = new WeakSet<Span>();
export const markHttpClientSpan = (span: Span): void => {
  httpSpans.add(span);
};

/**
 * A span that is not exported, standing in for the current trace: what runs
 * beneath it, and the `traceparent` sent from it, continue the caller's trace.
 * With no trace to continue, an unsampled one, so a quiet call made from a
 * background loop does not open a sampled root at the far end either.
 */
export const unexportedSpan = (): Span => {
  const current = trace.getSpanContext(context.active());
  return trace.wrapSpanContext(
    current && isSpanContextValid(current)
      ? current
      : trace.getSpanContext(unsampledContext())!,
  );
};
const unexported = unexportedSpan;

/**
 * A client span for one call to an external system: `{system} {operation}`,
 * e.g. `redis GET`, `postgresql pg_try_advisory_lock`, `smtp send`, a child of
 * the active span. End it with `span.end()`; its duration then feeds
 * `hs.client.operation.duration` (`client.system`, `client.operation`,
 * `client.outcome`). Set the outcome with {@link recordOutcome} or
 * {@link recordError}, or use {@link withClientSpan}, which does both.
 *
 * `system` and `operation` must be low-cardinality constants: they are the
 * span name and metric labels. `peer` is the host (or logical name) called;
 * it is capped in length. Name the operation, never the data: a recipient
 * address, a redis key or a SQL literal there is published to the trace store.
 *
 * At `level` `debug` (a long poll, a blocking pop: a call that waits by
 * design) an `otel:level=info` export does not see the span, while the
 * metric still counts it.
 *
 * Two optional attributes can be set afterwards: `client.target` (what was
 * operated on, when that is a name from code; never a metric label) and
 * `client.outcome` (via {@link recordOutcome}).
 */
export const clientSpan = (
  system: string,
  operation: string,
  peer: string,
  level: Level = 'info',
): Span => {
  const span = isExported(level)
    ? tracer().startSpan(`${system} ${operation}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'client.system': system,
          'client.operation': operation,
          'server.address': truncate(peer, MAX_ATTR_LEN),
          ...(DB_SYSTEMS.includes(system)
            ? { 'db.system.name': system, 'db.operation.name': operation }
            : {}),
        },
      })
    : unexported();
  const meta: ClientInfo = { system, operation, ended: false };
  info.set(span, meta);
  const started = performance.now();
  const end = span.end.bind(span);
  span.end = (endTime) => {
    if (!meta.ended) {
      meta.ended = true;
      recordClientOperation(
        (performance.now() - started) / 1000,
        meta.system,
        meta.operation,
        meta.outcome,
      );
    }
    end(endTime);
  };
  return span;
};

/**
 * Record `client.outcome`: `ok`, `error`, or a domain answer such as `busy`.
 * It is a metric label, so keep it to a handful of constants. `error` also
 * marks the span errored.
 */
export const recordOutcome = (span: Span, outcome: string): void => {
  span.setAttribute('client.outcome', outcome);
  const meta = info.get(span);
  if (meta) meta.outcome = outcome;
  if (outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
};

/**
 * Mark `span` failed and attach the error's message (capped) as an event.
 * Keep caller-supplied data out of the messages passed here: an error from a
 * URL-taking client often quotes the whole URL.
 */
export const recordError = (span: Span, error: unknown): void => {
  if (info.has(span)) recordOutcome(span, 'error');
  else span.setStatus({ code: SpanStatusCode.ERROR });
  const message =
    error instanceof Error ? error.message : `${error ?? 'error'}`;
  span.addEvent(`${httpSpans.has(span) ? 'http.client' : 'client'} failed`, {
    error: truncate(message, MAX_ATTR_LEN),
  });
};

/**
 * Run `fn` inside a {@link clientSpan}: the outcome is `ok` when it resolves
 * (unless `fn` recorded one) and `error` when it throws, and the span is
 * ended either way. The thrown error's message is not attached: call
 * {@link recordError} yourself where it is known to be safe.
 */
export const withClientSpan = async <T>(
  system: string,
  operation: string,
  peer: string,
  fn: (span: Span) => Promise<T> | T,
  level: Level = 'info',
): Promise<T> => {
  const span = clientSpan(system, operation, peer, level);
  try {
    const out = await context.with(trace.setSpan(context.active(), span), () =>
      fn(span),
    );
    if (info.get(span)?.outcome === undefined) recordOutcome(span, 'ok');
    return out;
  } catch (e) {
    recordOutcome(span, 'error');
    throw e;
  } finally {
    span.end();
  }
};
