import config from '../config';
import { DURATION_BUCKETS } from './metrics';

/**
 * The `otel` config block: the same keys, and defaults, as the Rust
 * services' `OtelConfig`, read with colon keys (`otel:enabled`) and so
 * overridable from the environment as `otel__enabled` etc.
 */
export interface OtelConfig {
  /** Master switch (`otel:enabled`, default false). */
  enabled: boolean;
  /** OTLP/HTTP base endpoint; `/v1/traces` and `/v1/metrics` are appended. */
  endpoint: string;
  /** Sent as `x-honeycomb-team` when set. Use the `[SECRET]:` indirection. */
  apiKey: string;
  /** `service.name` resource attribute (`unknown_service` when empty). */
  serviceName: string;
  /** `deployment.environment.name` resource attribute, when non-empty. */
  environment: string;
  /** Head-sampling ratio 0–1, parent-based (default 1). */
  sampleRatio: number;
  /**
   * What is exported, as a level (`info`, `debug`); empty means the log
   * level (`log:level`). At `info`, `debug` spans (quiet paths, polling
   * calls) are not exported but still counted.
   */
  level: string;
  /** Export metrics as well as traces (default true). */
  metricsEnabled: boolean;
  /** Metrics collection and export interval, seconds (default 60). */
  metricsIntervalSecs: number;
  /** Sent as `x-honeycomb-dataset` on metric exports only, when set. */
  metricsDataset: string;
  /** Report process and container (cgroup v2) metrics (default true). */
  processMetrics: boolean;
  /**
   * Refuse to export without an `apiKey` (default true). Set false when the
   * endpoint is a local OpenTelemetry Collector that holds the key itself.
   */
  apiKeyRequired: boolean;
  /**
   * Boundaries (seconds) of the HTTP and client duration histograms
   * (`otel:durationBuckets`, comma-separated). Default: the semantic
   * conventions' HTTP set, as the Rust services use. Change it only with the
   * queries that read the buckets in mind.
   */
  durationBuckets: readonly number[];
}

const parseBuckets = (raw: unknown): readonly number[] | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  const nums = parts.map((p) => Number(String(p).trim()));
  if (
    nums.length === 0 ||
    nums.some((n) => !Number.isFinite(n)) ||
    nums.some((n, i) => i > 0 && n <= nums[i - 1])
  )
    throw new Error(
      `Config "otel:durationBuckets": invalid bucket list "${raw}" (want ascending numbers)`,
    );
  return nums;
};

/** Read the `otel` block from config. */
export const readOtelConfig = (): OtelConfig => ({
  enabled: config.configBoolean('otel:enabled', false),
  endpoint: config.configString('otel:endpoint', 'https://api.honeycomb.io'),
  apiKey: config.configString('otel:apiKey', ''),
  serviceName: config.configString('otel:serviceName', ''),
  environment: config.configString('otel:environment', ''),
  sampleRatio: config.configFloat('otel:sampleRatio', 1),
  level: config.configString('otel:level', ''),
  metricsEnabled: config.configBoolean('otel:metricsEnabled', true),
  metricsIntervalSecs: config.configInteger('otel:metricsIntervalSecs', 60),
  metricsDataset: config.configString('otel:metricsDataset', ''),
  processMetrics: config.configBoolean('otel:processMetrics', true),
  apiKeyRequired: config.configBoolean('otel:apiKeyRequired', true),
  durationBuckets:
    parseBuckets(config.get('otel:durationBuckets')) ?? DURATION_BUCKETS,
});
