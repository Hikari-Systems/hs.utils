import {
  INVALID_SPAN_CONTEXT,
  Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { markHttpClientSpan, recordError, unexportedSpan } from './client';
import { MAX_ATTR_LEN, redactQuery, truncate } from './common';
import { recordHttpClientBodySize, recordHttpClientDuration } from './metrics';
import { Level, isExported, tracer } from './state';

/** What the client span of one call records. */
export interface TraceOptions {
  /**
   * The span's level: `debug` keeps a hot polling loop's calls out of an
   * `otel:level=info` export while `http.client.request.duration` still
   * counts them. Default `info`.
   */
  level?: Level;
  /**
   * Record only `scheme://host:port` on `url.full`: for a URL whose path or
   * query is, or may be, a credential (a webhook URL, a user-supplied target).
   */
  opaque?: boolean;
  /**
   * Record this path in place of the request's own (a route template such as
   * `/api/session/{id}`, when a path segment is a credential). The query's
   * parameter names are still recorded, never their values. Pass a constant.
   */
  path?: string;
}

type FetchInput = string | URL | Request;
type FetchInit = Parameters<typeof fetch>[1];

/** What a failed fetch was, without its message (which can quote the URL). */
export const fetchErrorKind = (e: unknown): string => {
  const err = e as { name?: string; cause?: { code?: string; name?: string } };
  const code = err?.cause?.code ?? '';
  if (
    err?.name === 'TimeoutError' ||
    err?.cause?.name === 'ConnectTimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ETIMEDOUT'
  )
    return 'timeout';
  if (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_SOCKET',
    ].includes(code)
  )
    return 'connect';
  if (err?.name === 'AbortError') return 'aborted';
  if (/redirect/i.test(`${(e as Error)?.message ?? ''}`)) return 'redirect';
  return 'error';
};

const urlFull = (url: URL, opts: TraceOptions): string => {
  const origin = `${url.protocol}//${url.host}`;
  if (opts.opaque) return truncate(origin, MAX_ATTR_LEN);
  const query = redactQuery(url.search.replace(/^\?/, ''));
  const sep = query === '' ? '' : '?';
  return truncate(
    `${origin}${opts.path ?? url.pathname}${sep}${query}`,
    MAX_ATTR_LEN,
  );
};

/**
 * `fetch` inside a client span named `{METHOD} {host}`, with W3C
 * `traceparent` (and `tracestate`) added to the request headers, so the
 * service called continues this trace. Behaves exactly like `fetch`
 * otherwise: same result, same errors.
 *
 * The span records `url.full` with the path and the query's parameter names
 * (never their values), `server.address` / `server.port`, the status (a 5xx
 * marks it errored; a 4xx is left to the caller) and, from `Content-Length`,
 * `http.response.body.size`. It feeds `http.client.request.duration`
 * (measured to the response headers) and `http.client.response.body.size`.
 */
export const fetchTracedWith = async (
  input: FetchInput,
  init: FetchInit | undefined,
  opts: TraceOptions = {},
): Promise<Response> => {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    // Not an absolute URL: fetch will reject it; nothing to trace.
    return fetch(input, init);
  }
  const method = (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  const host = url.hostname;
  const address = truncate(host, MAX_ATTR_LEN);
  const port = url.port === '' ? undefined : Number(url.port);
  const level = opts.level ?? 'info';
  const parent = context.active();

  let span: Span;
  if (isExported(level)) {
    span = tracer().startSpan(
      `${method} ${host}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': method,
          'server.address': address,
          ...(port !== undefined ? { 'server.port': port } : {}),
          'url.full': urlFull(url, opts),
        },
      },
      parent,
    );
  } else if (level === 'info') {
    // Not exported only because the export level is above info: carry the
    // caller's context as it is.
    span = trace.wrapSpanContext(
      trace.getSpanContext(parent) ?? INVALID_SPAN_CONTEXT,
    );
  } else {
    span = unexportedSpan();
  }
  markHttpClientSpan(span);

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  propagation.inject(trace.setSpan(parent, span), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  });

  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers });
  } catch (e) {
    recordHttpClientDuration(
      (performance.now() - started) / 1000,
      method,
      host,
      undefined,
    );
    recordError(span, fetchErrorKind(e));
    span.end();
    throw e;
  }
  const status = res.status;
  recordHttpClientDuration(
    (performance.now() - started) / 1000,
    method,
    host,
    status,
  );
  span.setAttribute('http.response.status_code', status);
  if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });

  // No body to measure: a Content-Length on these describes some other
  // response (the GET a HEAD stands for, the cached copy a 304 confirms).
  const bodyless =
    method === 'HEAD' ||
    status === 204 ||
    status === 304 ||
    (status >= 100 && status < 200);
  if (!bodyless) {
    const encoding = res.headers.get('content-encoding')?.trim() ?? '';
    const compressed = encoding !== '' && encoding.toLowerCase() !== 'identity';
    span.setAttribute('hs.http.response.body.compressed', compressed);
    const length = res.headers.get('content-length');
    const declared =
      length !== null && /^\s*\d+\s*$/.test(length)
        ? Number(length)
        : undefined;
    if (declared !== undefined) {
      span.setAttribute('http.response.body.size', declared);
      span.setAttribute('hs.http.response.body.size_source', 'header');
      recordHttpClientBodySize(declared, method, host, compressed);
    }
  }
  span.end();
  return res;
};

/**
 * {@link fetchTracedWith} with the default options: an `info` span recording
 * the path and the query's parameter names. The equivalent of the Rust
 * services' `send_traced`.
 */
export const fetchTraced = (
  input: FetchInput,
  init?: FetchInit,
): Promise<Response> => fetchTracedWith(input, init);

/**
 * {@link fetchTracedWith} recording only the origin (`scheme://host:port`):
 * for a URL whose path or query is, or may be, a credential. Still sends
 * `traceparent`. The equivalent of `send_traced_opaque`.
 */
export const fetchTracedOpaque = (
  input: FetchInput,
  init?: FetchInit,
): Promise<Response> => fetchTracedWith(input, init, { opaque: true });
