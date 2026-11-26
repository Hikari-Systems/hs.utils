import { randomBytes } from 'crypto';
import { Context, ROOT_CONTEXT, TraceFlags, trace } from '@opentelemetry/api';
import logging from '../logging';

const log = logging('otel');

/**
 * Cap, in UTF-8 bytes, for caller- or attacker-supplied string attributes
 * (paths, user agents, hosts, error messages). An unbounded `User-Agent` is
 * free inbound bytes turned into billable outbound ones.
 */
export const MAX_ATTR_LEN = 256;

export const REDACTED = '<redacted>';

/** `s` cut to at most `max` UTF-8 bytes (never mid code point), plus `…`. */
export const truncate = (s: string, max = MAX_ATTR_LEN): string => {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let end = max;
  // Back off continuation bytes (10xxxxxx) to a code point boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString('utf8')}…`;
};

/**
 * Which query parameters were present, never their values:
 * `a=1&b` becomes `a=<redacted>&<redacted>`.
 *
 * Every value is redacted, not a deny-list of sensitive names: a query string
 * can carry a single-use credential (an OAuth2 `code`), and spans leave the
 * building. A bare token with no `=` could itself be a secret, so it is
 * replaced whole. Parameter names are caller-supplied too, so the result is
 * capped.
 */
export const redactQuery = (query: string | undefined | null): string => {
  if (!query) return '';
  let out = '';
  const pairs = query.split('&');
  for (let i = 0; i < pairs.length; i += 1) {
    if (i > 0) out += '&';
    const eq = pairs[i].indexOf('=');
    const name = eq >= 0 ? pairs[i].slice(0, eq) : '';
    out += name !== '' ? `${name}=${REDACTED}` : REDACTED;
    if (Buffer.byteLength(out) >= MAX_ATTR_LEN)
      return truncate(out, MAX_ATTR_LEN);
  }
  return out;
};

// ── path redaction ──────────────────────────────────────────────────────────

let pathRedactor: ((path: string) => string) | undefined;

/**
 * Install a process-wide redactor for the concrete request path the server
 * middleware records as `url.path`, for a service whose paths carry a
 * credential (`/hooks/{token}/…`). The span NAME is already the route
 * template, so only the attribute needs it. Call it once, before serving; a
 * second call is ignored and returns `false`.
 */
export const setPathRedactor = (redact: (path: string) => string): boolean => {
  if (pathRedactor) {
    log.warn('otel path redactor already installed; the second one is ignored');
    return false;
  }
  pathRedactor = redact;
  return true;
};

export const redactPath = (path: string): string =>
  pathRedactor ? pathRedactor(path) : path;

// ── quiet paths ─────────────────────────────────────────────────────────────

/** The path a container healthcheck polls; always quiet. */
export const HEALTHCHECK_PATH = '/healthcheck';

let quietPaths: ReadonlySet<string> | undefined;

/**
 * Install process-wide extra quiet paths: exact request paths whose server
 * span is `debug`, as `/healthcheck`'s always is. At `otel:level=info` the
 * request and everything beneath it is not exported (and the `traceparent` it
 * sends on says "not sampled"), while `http.server.request.duration` still
 * counts it. For a long poll, whose duration is the hold. Call it once,
 * before serving; a second call is ignored and returns `false`.
 */
export const setQuietPaths = (paths: readonly string[]): boolean => {
  if (quietPaths) {
    log.warn('otel quiet paths already installed; the second set is ignored');
    return false;
  }
  quietPaths = new Set(paths);
  return true;
};

export const isQuietPath = (path: string): boolean =>
  path === HEALTHCHECK_PATH || (quietPaths?.has(path) ?? false);

// ── metric peer labels ──────────────────────────────────────────────────────

/**
 * How many distinct dotted hosts `http.client.request.duration` labels by
 * name in one process before recording further ones as `other`.
 */
export const MAX_METRIC_PEERS = 20;

let peerPins: readonly string[] | undefined;

/**
 * Pin hosts that the HTTP client metrics always label by name: an exact host,
 * or a suffix starting with `.` (`.example.com` matches that host and any
 * subdomain). Spans keep the real `server.address` whatever is set.
 *
 * Without pins, a dotless host (an in-cluster service name) is always
 * labelled by name, and so are the first {@link MAX_METRIC_PEERS} distinct
 * dotted hosts; any host after those is `other`. Call once at startup; a
 * second call is ignored and returns `false`.
 */
export const setMetricPeerHosts = (hosts: readonly string[]): boolean => {
  if (peerPins) {
    log.warn('metric peer hosts already installed; the second set is ignored');
    return false;
  }
  peerPins = [...hosts];
  return true;
};

export const pinMatches = (pattern: string, host: string): boolean =>
  pattern.startsWith('.')
    ? host === pattern.slice(1) || host.endsWith(pattern)
    : host === pattern;

export const isPinnedMetricPeer = (host: string): boolean =>
  peerPins?.some((p) => pinMatches(p, host)) ?? false;

/** A bounded label set: the first `max` values keep their name. */
export class BoundedLabels {
  private readonly admitted = new Set<string>();

  constructor(
    private readonly max: number,
    private readonly always: (value: string) => boolean = () => false,
  ) {}

  label(value: string): string {
    if (this.always(value) || this.admitted.has(value)) return value;
    if (this.admitted.size < this.max) {
      this.admitted.add(value);
      return value;
    }
    return 'other';
  }
}

/** `server.address` as the HTTP client metrics label it. */
export const peerLabels = () =>
  new BoundedLabels(
    MAX_METRIC_PEERS,
    (host) => host === '' || !host.includes('.') || isPinnedMetricPeer(host),
  );

// ── session recording ───────────────────────────────────────────────────────

/**
 * The header a session-recorded browser page sends its recording's session
 * id in, so the server span can carry it as `session_recording.id`.
 */
export const SESSION_RECORDING_HEADER = 'x-session-recording-id';

/** The header value if it is a UUID, else `undefined`. */
export const sessionRecordingId = (
  value: string | undefined,
): string | undefined => {
  const v = value?.trim();
  return v &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      v,
    )
    ? v
    : undefined;
};

// ── unsampled context ───────────────────────────────────────────────────────

/**
 * A context whose current span is a valid but UNSAMPLED remote span: the
 * parent-based sampler drops everything started beneath it, and the
 * `traceparent` sent from it says "not sampled", so the next service drops
 * its side too. Real ids: an invalid (all-zero) parent is no parent at all,
 * and the sampler would start a sampled root.
 */
export const unsampledContext = (): Context =>
  trace.setSpanContext(ROOT_CONTEXT, {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
    traceFlags: TraceFlags.NONE,
    isRemote: true,
  });
