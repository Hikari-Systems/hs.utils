import {
  Context,
  ROOT_CONTEXT,
  Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import {
  MAX_ATTR_LEN,
  SESSION_RECORDING_HEADER,
  isQuietPath,
  redactPath,
  redactQuery,
  sessionRecordingId,
  truncate,
  unsampledContext,
} from './common';
import { activeRequests, recordServerDuration } from './metrics';
import { isExported, tracer } from './state';

/**
 * What a server span is named when no route matched (a 404, a static-file
 * hit). Deliberately constant: the raw path there is entirely caller-chosen,
 * and using it would mint one span name per probe. The real path is still on
 * `url.path`, bounded.
 */
export const UNMATCHED = '<unmatched>';

const SERVER_SPANS = new WeakMap<Request, Span>();

const splitUrl = (url: string): [string, string] => {
  const q = url.indexOf('?');
  return q < 0 ? [url, ''] : [url.slice(0, q), url.slice(q + 1)];
};

const hasParams = (path: string) => /[:*?(]/.test(path);

/**
 * The route TEMPLATE that handled `req` (`/api/items/:id`), never the concrete
 * path; {@link UNMATCHED} when no route did.
 */
const routeOf = (req: Request, path: string): string => {
  const routePath = req.route?.path;
  if (routePath === undefined) return UNMATCHED;
  const template =
    typeof routePath === 'string' ? routePath : String(routePath);
  const candidate = `${req.baseUrl ?? ''}${template}`;
  // Once an error has left a nested router, express has already reset
  // `baseUrl`; a template without parameters can then be recovered from the
  // path it matched.
  if (
    candidate !== path &&
    typeof routePath === 'string' &&
    !hasParams(template) &&
    path.endsWith(template)
  )
    return path;
  return candidate;
};

/**
 * Express middleware opening a server span per request, the counterpart of
 * the Rust services' `actix_trace()`: named `{METHOD} {route template}`
 * (`GET /api/items/:id`, or `GET <unmatched>`), adopting the caller's W3C
 * `traceparent`, with `http.request.method`, `http.route`, `url.path`
 * (through {@link setPathRedactor}, capped), `url.query` (names only),
 * `network.protocol.version`, `user_agent.original` (capped),
 * `http.response.status_code` and, from {@link SESSION_RECORDING_HEADER},
 * `session_recording.id`. Only a 5xx marks the span errored.
 *
 * It feeds `http.server.request.duration` (measured to the moment the
 * response status is sent, so a long-lived body is not one enormous request)
 * and `http.server.active_requests`.
 *
 * `/healthcheck`, and paths given to {@link setQuietPaths}, are quiet: at
 * `otel:level=info` nothing of them is exported (their children and the
 * `traceparent` they send on are unsampled), while the metrics still count
 * them.
 *
 * Use it first (`app.use(otel.traceMiddleware())`), before the routes.
 */
export const traceMiddleware =
  (): RequestHandler => (req: Request, res: Response, next: NextFunction) => {
    const method = req.method;
    const [path, query] = splitUrl(req.originalUrl ?? req.url);
    const quiet = isQuietPath(path);

    let span: Span;
    let ctx: Context;
    if (isExported(quiet ? 'debug' : 'info')) {
      const parent = propagation.extract(ROOT_CONTEXT, req.headers);
      const recording = sessionRecordingId(
        req.get(SESSION_RECORDING_HEADER) ?? undefined,
      );
      span = tracer().startSpan(
        `${method} ${UNMATCHED}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            'http.request.method': method,
            'url.path': truncate(redactPath(path), MAX_ATTR_LEN),
            'url.query': redactQuery(query),
            'network.protocol.version': `HTTP/${req.httpVersion}`,
            'user_agent.original': truncate(
              req.get('user-agent') ?? '',
              MAX_ATTR_LEN,
            ),
            ...(recording ? { 'session_recording.id': recording } : {}),
          },
        },
        parent,
      );
      ctx = trace.setSpan(parent, span);
    } else {
      // Not exported: everything beneath it is dropped by the parent-based
      // sampler, and the traceparent it sends on says "not sampled".
      ctx = unsampledContext();
      span = trace.getSpan(ctx)!;
    }
    SERVER_SPANS.set(req, span);

    const started = performance.now();
    let responded = false;
    let ended = false;
    activeRequests(method, 1);

    const onStatus = () => {
      if (responded) return;
      responded = true;
      const route = routeOf(req, path);
      const status = res.statusCode;
      span.updateName(`${method} ${route}`);
      span.setAttribute('http.route', route);
      span.setAttribute('http.response.status_code', status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      recordServerDuration(
        (performance.now() - started) / 1000,
        method,
        route,
        status,
      );
    };
    const writeHead = res.writeHead;
    res.writeHead = function patched(this: Response, ...args: any[]) {
      if (typeof args[0] === 'number') res.statusCode = args[0];
      onStatus();
      return (writeHead as (...a: any[]) => Response).apply(this, args);
    } as Response['writeHead'];

    const end = () => {
      if (ended) return;
      ended = true;
      // A request that never produced a status (the client went away) leaves
      // the in-flight count, and is not a duration: there was no response.
      activeRequests(method, -1);
      span.end();
    };
    res.once('finish', end);
    res.once('close', end);

    context.with(ctx, next);
  };

/**
 * Express error middleware recording the error on the request's server span
 * (an exception event, capped), then passing it on unchanged. Mount it after
 * the routes and before the service's own error handler.
 */
export const traceErrorMiddleware =
  (): ErrorRequestHandler =>
  (err: unknown, req: Request, _res: Response, next: NextFunction) => {
    const span = SERVER_SPANS.get(req);
    if (span) {
      const message =
        err instanceof Error ? err.message : `${err ?? 'request failed'}`;
      span.addEvent('request failed', {
        error: truncate(message, MAX_ATTR_LEN),
      });
    }
    next(err);
  };
