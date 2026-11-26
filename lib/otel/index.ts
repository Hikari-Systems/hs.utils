/**
 * OpenTelemetry traces and metrics over OTLP/HTTP, configured by the `otel`
 * config block, with the same span names, metric names, units and attributes
 * as the Rust services' `hs-utils` `otel` module, so one set of queries reads
 * both.
 *
 * - {@link init} / {@link shutdown}: the tracer and meter providers, W3C
 *   `traceparent` propagation and an AsyncLocalStorage context manager.
 *   Inert (nothing started, nothing exported) unless `otel:enabled` is true.
 * - {@link traceMiddleware}: an Express server span per request, plus
 *   `http.server.request.duration` and `http.server.active_requests`.
 * - {@link fetchTraced} / {@link fetchTracedOpaque}: outbound `fetch` in a
 *   client span, `traceparent` added, query values redacted, plus
 *   `http.client.request.duration`.
 * - {@link clientSpan} / {@link recordOutcome} / {@link withClientSpan}: any
 *   other outbound call, plus `hs.client.operation.duration`.
 * - Process, container (cgroup v2) and Node.js runtime metrics, collected at
 *   each export.
 * - {@link GenAiCall}: one span and the `gen_ai.*` metrics per model call.
 */
import {
  Context,
  ROOT_CONTEXT,
  context,
  metrics,
  propagation,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  IMetricReader,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  SpanExporter,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import logging from '../logging';
import config from '../config';
import { OtelConfig, readOtelConfig } from './config';
import { SCOPE, install, registerSource, uninstall } from './metrics';
import * as procfs from './procfs';
import * as runtime from './runtime';
import { levelRank, state } from './state';

const log = logging('otel');

export interface InitOptions {
  /** Overrides on top of the `otel` config block. */
  config?: Partial<OtelConfig>;
  /**
   * Export spans here instead of OTLP, through a simple (unbatched)
   * processor: an in-memory exporter in tests.
   */
  spanExporter?: SpanExporter;
  /** Read metrics with this reader instead of the periodic OTLP one. */
  metricReader?: IMetricReader;
}

/**
 * Start exporting, as the `otel` config block says. Call it once, as early as
 * possible (before the app is built), and {@link shutdown} on the way out.
 * Returns whether export is on. A second call is ignored.
 *
 * With `otel:enabled` false (the default) nothing is started or registered
 * globally: every span this module makes is a no-op and no metric is kept.
 * `otel:apiKey` empty is treated the same way (with a warning) unless
 * `otel:apiKeyRequired` is false, as for a local Collector.
 */
export const init = (options: InitOptions = {}): boolean => {
  if (state.started) {
    log.warn('otel init called twice; the second call is ignored');
    return state.enabled;
  }
  state.started = true;
  const cfg: OtelConfig = { ...readOtelConfig(), ...options.config };
  if (!cfg.enabled) return false;

  const keyless = cfg.apiKey.trim() === '';
  if (keyless && cfg.apiKeyRequired) {
    log.warn(
      'otel:enabled is true but otel:apiKey is empty: export disabled ' +
        '(Honeycomb rejects unauthenticated OTLP silently; set otel:apiKeyRequired=false ' +
        'to export to a Collector that holds the key)',
    );
    return false;
  }

  const unnamed = cfg.serviceName.trim() === '';
  const serviceName = unnamed ? 'unknown_service' : cfg.serviceName;
  state.serviceName = serviceName;
  state.exportRank = levelRank(
    cfg.level.trim() !== ''
      ? cfg.level
      : config.configString('log:level', 'info'),
  );

  const base = cfg.endpoint.replace(/\/+$/, '');
  const headers: Record<string, string> = keyless
    ? {}
    : { 'x-honeycomb-team': cfg.apiKey };

  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        'service.name': serviceName,
        ...(cfg.environment.trim() !== ''
          ? { 'deployment.environment.name': cfg.environment }
          : {}),
      }),
    );

  const ratio = Math.min(Math.max(cfg.sampleRatio, 0), 1);
  state.tracerProvider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(ratio),
    }),
    spanProcessors: [
      options.spanExporter
        ? new SimpleSpanProcessor({ exporter: options.spanExporter })
        : new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({
              url: `${base}/v1/traces`,
              headers,
              timeoutMillis: 10_000,
            }),
          }),
    ],
  });
  trace.setGlobalTracerProvider(state.tracerProvider);
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  // Without this, outbound traceparent headers are never written and every
  // downstream service starts its own disconnected root trace.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  if (cfg.metricsEnabled) {
    const intervalMs = Math.max(cfg.metricsIntervalSecs, 1) * 1000;
    const reader =
      options.metricReader ??
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${base}/v1/metrics`,
          headers:
            cfg.metricsDataset.trim() !== ''
              ? { ...headers, 'x-honeycomb-dataset': cfg.metricsDataset }
              : headers,
          timeoutMillis: 10_000,
        }),
        exportIntervalMillis: intervalMs,
        exportTimeoutMillis: Math.min(10_000, intervalMs),
      });
    state.meterProvider = new MeterProvider({ resource, readers: [reader] });
    metrics.setGlobalMeterProvider(state.meterProvider);
    install(state.meterProvider.getMeter(SCOPE), {
      durationBuckets: cfg.durationBuckets,
    });
    if (cfg.processMetrics) registerSource(procfs.source());
    registerSource(runtime.source());
  }
  state.enabled = true;

  log.info(
    `otel enabled (OTLP/http): service.name=${serviceName} endpoint=${cfg.endpoint} ` +
      `sample_ratio=${ratio} metrics=${cfg.metricsEnabled} ` +
      `metrics_interval_secs=${cfg.metricsIntervalSecs}`,
  );
  if (unnamed)
    log.warn(
      'otel:serviceName is not set: exporting as "unknown_service"; set otel__serviceName',
    );
  return true;
};

/**
 * Flush and stop the exporters. Metrics go first, so their final collection
 * is not the casualty of a slow span flush under a shutdown deadline.
 * Idempotent; never throws.
 */
export const shutdown = async (): Promise<void> => {
  const { meterProvider, tracerProvider } = state;
  state.meterProvider = undefined;
  state.tracerProvider = undefined;
  if (meterProvider) {
    await meterProvider
      .shutdown()
      .catch((e) => log.warn(`otel metrics shutdown failed: ${e}`));
    uninstall();
  }
  if (tracerProvider)
    await tracerProvider
      .shutdown()
      .catch((e) => log.warn(`otel shutdown failed: ${e}`));
};

/** Whether {@link init} turned export on. */
export const isEnabled = (): boolean => state.enabled;

/**
 * Add the current (or the given) trace context to outbound headers as W3C
 * `traceparent`, for a call not made through {@link fetchTraced}. A no-op
 * without {@link init} or an active span.
 */
export const injectContext = (
  headers: Record<string, string> | Headers,
  ctx: Context = context.active(),
): void => {
  if (headers instanceof Headers)
    propagation.inject(ctx, headers, {
      set: (c, k, v) => c.set(k, v),
    });
  else propagation.inject(ctx, headers);
};

/** The remote trace context in inbound headers. */
export const extractContext = (
  headers: Record<string, string | string[] | undefined>,
): Context => propagation.extract(ROOT_CONTEXT, headers);

export type { OtelConfig } from './config';
export { readOtelConfig } from './config';
export type { Level } from './state';
export { tracer } from './state';
export {
  HEALTHCHECK_PATH,
  MAX_ATTR_LEN,
  MAX_METRIC_PEERS,
  SESSION_RECORDING_HEADER,
  redactQuery,
  setMetricPeerHosts,
  setPathRedactor,
  setQuietPaths,
  truncate,
} from './common';
export {
  clientSpan,
  recordError,
  recordOutcome,
  withClientSpan,
} from './client';
export type { TraceOptions } from './fetch';
export { fetchTraced, fetchTracedOpaque, fetchTracedWith } from './fetch';
export { UNMATCHED, traceErrorMiddleware, traceMiddleware } from './express';
export type { PoolLike } from './metrics';
export { DURATION_BUCKETS, SCOPE, registerPoolGauges } from './metrics';
export { readContainerMemoryUsage } from './procfs';
export type { GenAiUsage } from './genai';
export { GENAI_OPERATION, GENAI_PROVIDER, GenAiCall } from './genai';
