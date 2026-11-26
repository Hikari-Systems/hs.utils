import { trace, Tracer } from '@opentelemetry/api';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';
import type { TracerProvider } from '@opentelemetry/sdk-trace';

/**
 * How verbose a span this module makes is. A span below the export level
 * (`otel:level`, default the log level) is not exported, but is still counted
 * by the metrics: a healthcheck at `debug` under an `info` export, say.
 */
export type Level = 'trace' | 'debug' | 'info';

const RANKS: Record<string, number> = {
  trace: 0,
  silly: 0,
  debug: 1,
  verbose: 1,
  info: 2,
  http: 2,
  warn: 3,
  error: 4,
  off: 5,
};

/**
 * The rank of an export-level directive. Only its default level counts: the
 * first comma-separated part without an `=` (`"info,some::target=debug"` is
 * `info`). Unknown or empty is `info`.
 */
export const levelRank = (directive: string): number => {
  const base = directive
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .find((p) => p !== '' && !p.includes('='));
  return base !== undefined && base in RANKS ? RANKS[base] : RANKS.info;
};

interface State {
  started: boolean;
  enabled: boolean;
  serviceName: string;
  exportRank: number;
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
}

export const state: State = {
  started: false,
  enabled: false,
  serviceName: 'unknown_service',
  exportRank: RANKS.info,
};

/** Whether a span this module makes at `level` is exported. */
export const isExported = (level: Level): boolean =>
  RANKS[level] >= state.exportRank;

/**
 * The tracer every span of this module is made with: named after the
 * service (`otel:serviceName`), as the Rust services' are. Use it for a
 * service's own spans too, so they share the instrumentation scope.
 */
export const tracer = (): Tracer => trace.getTracer(state.serviceName);
