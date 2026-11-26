import {
  Attributes,
  Counter,
  Histogram,
  Meter,
  Observable,
  UpDownCounter,
} from '@opentelemetry/api';
import logging from '../logging';
import { BoundedLabels, peerLabels } from './common';

const log = logging('otel');

/** Instrumentation scope of every metric this module reports. */
export const SCOPE = 'hs-utils';

/**
 * Bucket boundaries (seconds) for the HTTP and client duration histograms:
 * the semantic conventions' HTTP set. The SDK default (0, 5, 10, 25 … 10000)
 * assumes milliseconds and would put every request in the first bucket.
 */
export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

/** GenAI call durations and time to first chunk, extended to five minutes. */
export const GENAI_DURATION_BUCKETS: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92, 163.84, 327.68,
];

/** Response body sizes, 1 KiB to 512 MiB. */
export const BODY_SIZE_BUCKETS: readonly number[] = [
  1024, 16384, 131072, 1048576, 8388608, 67108864, 536870912,
];

/** `gen_ai.client.token.usage`: the semantic conventions' boundaries. */
export const GENAI_TOKEN_BUCKETS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
];

/** `hs.gen_ai.client.output_throughput`, output tokens per second. */
export const GENAI_THROUGHPUT_BUCKETS: readonly number[] = [
  1, 2, 5, 10, 20, 40, 60, 80, 100, 150, 200, 300, 500, 1000,
];

/**
 * Distinct `gen_ai.request.model` labels a process keeps; later models are
 * labelled `other`. Spans keep the real id.
 */
export const MAX_METRIC_MODELS = 20;

// ── gauge sources ───────────────────────────────────────────────────────────

/** One observed value of a gauge, or of a cumulative count the OS keeps. */
export interface Sample {
  name: string;
  value: number;
  attrs?: Attributes;
}

/**
 * Something that reports samples at each collection. Runs synchronously in
 * the collection, so it must only read memory or tiny files.
 */
export type GaugeSource = (out: Sample[]) => void;

const sources: GaugeSource[] = [];

export const registerSource = (source: GaugeSource): void => {
  sources.push(source);
};

type Kind = 'gauge' | 'cumulative';

/**
 * Every name a gauge source may report. A sample under a name not listed is
 * dropped: an instrument has to exist before collection, and this keeps the
 * exported set reviewable in one place. A `cumulative` is a count the OS
 * keeps (CPU seconds, bytes), exported as a monotonic sum.
 */
export const CATALOG: readonly (readonly [string, Kind, string, string])[] = [
  // process (/proc/self)
  [
    'process.cpu.time',
    'cumulative',
    's',
    'CPU time used by this process, by cpu.mode',
  ],
  [
    'process.cpu.utilization',
    'gauge',
    '1',
    "Share of the CPU available to this process (its container's quota, else all CPUs) used since the last collection",
  ],
  ['process.memory.usage', 'gauge', 'By', 'Resident set size'],
  ['process.memory.virtual', 'gauge', 'By', 'Virtual memory size'],
  ['process.thread.count', 'gauge', '{thread}', 'Threads in this process'],
  [
    'process.open_file_descriptor.count',
    'gauge',
    '{file_descriptor}',
    'Open file descriptors',
  ],
  [
    'process.disk.io',
    'cumulative',
    'By',
    'Bytes this process read from / wrote to storage, by disk.io.direction',
  ],
  [
    'hs.process.blkio_delay',
    'cumulative',
    's',
    'Time this process spent blocked on block I/O (kernel delay accounting)',
  ],
  // container (cgroup v2)
  [
    'container.cpu.time',
    'cumulative',
    's',
    'CPU time used by every process in this container',
  ],
  [
    'hs.container.cpu.throttled_time',
    'cumulative',
    's',
    'Time this container was throttled by its CPU quota',
  ],
  ['hs.container.cpu.limit', 'gauge', '{cpu}', "This container's CPU quota"],
  [
    'container.memory.usage',
    'gauge',
    'By',
    'Memory charged to this container (cgroup memory.current)',
  ],
  [
    'hs.container.memory.limit',
    'gauge',
    'By',
    "This container's memory limit (cgroup memory.max)",
  ],
  [
    'hs.container.memory.oom_kills',
    'cumulative',
    '{event}',
    'Processes in this container killed by the OOM killer (cgroup memory.events oom_kill)',
  ],
  [
    'hs.container.memory.oom_events',
    'cumulative',
    '{event}',
    "Times this container's memory limit was reached and the OOM killer invoked (cgroup memory.events oom)",
  ],
  [
    'hs.container.pressure',
    'gauge',
    '%',
    "Share of the last 10 s tasks in this container were stalled on a resource (PSI avg10), by resource (cpu|memory|io) and kind (some|full). resource=io is the container's iowait",
  ],
  // Node.js runtime (in place of the Rust services' tokio gauges)
  [
    'v8js.memory.heap.used',
    'gauge',
    'By',
    'V8 heap memory used, by v8js.heap.space.name',
  ],
  [
    'v8js.memory.heap.limit',
    'gauge',
    'By',
    'V8 heap memory reserved, by v8js.heap.space.name',
  ],
  [
    'v8js.memory.heap.space.available_size',
    'gauge',
    'By',
    'V8 heap space still available, by v8js.heap.space.name',
  ],
  [
    'v8js.memory.heap.space.physical_size',
    'gauge',
    'By',
    'V8 heap space committed physical memory, by v8js.heap.space.name',
  ],
  [
    'nodejs.eventloop.delay.min',
    'gauge',
    's',
    'Event loop delay since the last collection: minimum',
  ],
  [
    'nodejs.eventloop.delay.max',
    'gauge',
    's',
    'Event loop delay since the last collection: maximum',
  ],
  [
    'nodejs.eventloop.delay.mean',
    'gauge',
    's',
    'Event loop delay since the last collection: mean',
  ],
  [
    'nodejs.eventloop.delay.stddev',
    'gauge',
    's',
    'Event loop delay since the last collection: standard deviation',
  ],
  [
    'nodejs.eventloop.delay.p50',
    'gauge',
    's',
    'Event loop delay since the last collection: 50th percentile',
  ],
  [
    'nodejs.eventloop.delay.p90',
    'gauge',
    's',
    'Event loop delay since the last collection: 90th percentile',
  ],
  [
    'nodejs.eventloop.delay.p99',
    'gauge',
    's',
    'Event loop delay since the last collection: 99th percentile',
  ],
  [
    'nodejs.eventloop.utilization',
    'gauge',
    '1',
    'Share of the time since the last collection the event loop was busy',
  ],
  [
    'nodejs.eventloop.time',
    'cumulative',
    's',
    'Time the event loop spent, by nodejs.eventloop.state (active|idle)',
  ],
  // db pools
  [
    'db.client.connection.count',
    'gauge',
    '{connection}',
    'Pool connections, by state (idle|used)',
  ],
  [
    'db.client.connection.max',
    'gauge',
    '{connection}',
    "The pool's maximum size",
  ],
];

const CATALOGUED = new Set(CATALOG.map(([name]) => name));

/** Run every source once and keep only catalogued samples. */
export const collectSamples = (): Sample[] => {
  const out: Sample[] = [];
  sources.slice().forEach((source) => {
    try {
      source(out);
    } catch (e) {
      // A failing source loses its own samples, not everyone's.
      log.debug(`otel gauge source failed: ${(e as Error)?.message}`);
    }
  });
  return out.filter((s) => CATALOGUED.has(s.name));
};

// ── instruments ─────────────────────────────────────────────────────────────

interface Instruments {
  serverDuration: Histogram;
  active: UpDownCounter;
  clientHttpDuration: Histogram;
  clientBodySize: Histogram;
  clientDuration: Histogram;
  genaiDuration: Histogram;
  genaiTokens: Histogram;
  genaiTtft: Histogram;
  genaiThroughput: Histogram;
  genaiCost: Counter;
  peers: BoundedLabels;
  models: BoundedLabels;
}

let instruments: Instruments | undefined;

export interface InstallOptions {
  /** Boundaries for the HTTP and client duration histograms. */
  durationBuckets?: readonly number[];
}

/**
 * Create the instruments on `meter` (scope {@link SCOPE}) and the catalog's
 * observable gauges, read from the registered sources at each collection.
 * Called once from `init`.
 */
export const install = (meter: Meter, opts: InstallOptions = {}): void => {
  const buckets = [...(opts.durationBuckets ?? DURATION_BUCKETS)];
  const hist = (name: string, description: string) =>
    meter.createHistogram(name, {
      unit: 's',
      description,
      advice: { explicitBucketBoundaries: buckets },
    });
  instruments = {
    serverDuration: hist(
      'http.server.request.duration',
      'Inbound request duration, to the response status',
    ),
    active: meter.createUpDownCounter('http.server.active_requests', {
      unit: '{request}',
      description: 'Inbound requests in progress',
    }),
    clientHttpDuration: hist(
      'http.client.request.duration',
      'Outbound HTTP request duration, to the response status',
    ),
    clientBodySize: meter.createHistogram('http.client.response.body.size', {
      unit: 'By',
      description:
        'Outbound HTTP response body size; hs.http.response.body.compressed says which size',
      advice: { explicitBucketBoundaries: [...BODY_SIZE_BUCKETS] },
    }),
    clientDuration: hist(
      'hs.client.operation.duration',
      'Outbound call duration (redis, locks, pub/sub, SMTP …), by outcome',
    ),
    genaiDuration: meter.createHistogram('gen_ai.client.operation.duration', {
      unit: 's',
      description: 'GenAI call duration, request to last byte',
      advice: { explicitBucketBoundaries: [...GENAI_DURATION_BUCKETS] },
    }),
    genaiTokens: meter.createHistogram('gen_ai.client.token.usage', {
      unit: '{token}',
      description:
        'Input and output tokens per GenAI call, by gen_ai.token.type',
      advice: { explicitBucketBoundaries: [...GENAI_TOKEN_BUCKETS] },
    }),
    genaiTtft: meter.createHistogram(
      'gen_ai.client.operation.time_to_first_chunk',
      {
        unit: 's',
        description: 'Time to the first chunk of a streamed GenAI response',
        advice: { explicitBucketBoundaries: [...GENAI_DURATION_BUCKETS] },
      },
    ),
    genaiThroughput: meter.createHistogram(
      'hs.gen_ai.client.output_throughput',
      {
        unit: '{token}/s',
        description:
          'Output tokens per second of generation (whole call when not streamed)',
        advice: { explicitBucketBoundaries: [...GENAI_THROUGHPUT_BUCKETS] },
      },
    ),
    genaiCost: meter.createCounter('hs.gen_ai.client.cost', {
      unit: 'USD',
      description: 'What GenAI calls cost, as the provider reports it',
    }),
    peers: peerLabels(),
    models: new BoundedLabels(MAX_METRIC_MODELS),
  };

  const observables = new Map<string, Observable>();
  CATALOG.forEach(([name, kind, unit, description]) => {
    observables.set(
      name,
      kind === 'gauge'
        ? meter.createObservableGauge(name, { unit, description })
        : meter.createObservableCounter(name, { unit, description }),
    );
  });
  // One pass over the sources per collection, not one per instrument.
  meter.addBatchObservableCallback(
    (result) => {
      collectSamples().forEach((s) => {
        const o = observables.get(s.name);
        if (o) result.observe(o, s.value, s.attrs ?? {});
      });
    },
    [...observables.values()],
  );
};

/** Stop recording (the instruments' provider is shut down). */
export const uninstall = (): void => {
  instruments = undefined;
};

export const metricsOn = (): boolean => instruments !== undefined;

// ── recording ───────────────────────────────────────────────────────────────

export const activeRequests = (method: string, delta: number): void => {
  instruments?.active.add(delta, { 'http.request.method': method });
};

export const recordServerDuration = (
  secs: number,
  method: string,
  route: string,
  status: number,
): void => {
  instruments?.serverDuration.record(secs, {
    'http.request.method': method,
    'http.route': route,
    'http.response.status_code': status,
  });
};

const clientAttrs = (i: Instruments, method: string, address: string) => ({
  'http.request.method': method,
  'server.address': i.peers.label(address),
});

/**
 * `http.client.request.duration`, with the status or, when there was no
 * response, `error.type = no_response`.
 */
export const recordHttpClientDuration = (
  secs: number,
  method: string,
  address: string,
  status: number | undefined,
): void => {
  const i = instruments;
  if (!i) return;
  const a: Attributes = clientAttrs(i, method, address);
  if (status !== undefined) a['http.response.status_code'] = status;
  else a['error.type'] = 'no_response';
  i.clientHttpDuration.record(secs, a);
};

export const recordHttpClientBodySize = (
  bytes: number,
  method: string,
  address: string,
  compressed: boolean,
): void => {
  const i = instruments;
  if (!i) return;
  i.clientBodySize.record(bytes, {
    ...clientAttrs(i, method, address),
    'hs.http.response.body.compressed': compressed,
  });
};

export const recordClientOperation = (
  secs: number,
  system: string,
  operation: string,
  outcome: string | undefined,
): void => {
  instruments?.clientDuration.record(secs, {
    'client.system': system,
    'client.operation': operation,
    'client.outcome': outcome ?? 'unknown',
  });
};

/** What a finished GenAI call carries for its metrics. */
export interface GenAiFields {
  operation: string;
  provider: string;
  model: string;
  task: string;
  stream: boolean;
  errorType?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationS: number;
  ttftS?: number;
  tokensPerSecond?: number;
  costUsd?: number;
}

export const recordGenAi = (g: GenAiFields): void => {
  const i = instruments;
  if (!i) return;
  const a: Attributes = {
    'gen_ai.operation.name': g.operation,
    'gen_ai.provider.name': g.provider,
    'gen_ai.request.model': i.models.label(g.model),
    'gen_ai.request.stream': g.stream,
    'hs.gen_ai.task': g.task,
  };
  if (g.errorType !== undefined) a['error.type'] = g.errorType;
  i.genaiDuration.record(g.durationS, a);
  if (g.ttftS !== undefined) i.genaiTtft.record(g.ttftS, a);
  if (g.tokensPerSecond !== undefined)
    i.genaiThroughput.record(g.tokensPerSecond, a);
  if (g.costUsd !== undefined && Number.isFinite(g.costUsd) && g.costUsd >= 0)
    i.genaiCost.add(g.costUsd, a);
  (
    [
      ['input', g.inputTokens],
      ['output', g.outputTokens],
    ] as const
  ).forEach(([kind, n]) => {
    if (n !== undefined && n >= 0)
      i.genaiTokens.record(n, { ...a, 'gen_ai.token.type': kind });
  });
};

// ── db pools ────────────────────────────────────────────────────────────────

/** What a `pg.Pool` exposes that the pool gauges read. */
export interface PoolLike {
  totalCount: number;
  idleCount: number;
  options?: { max?: number };
}

/**
 * Report `db.client.connection.count{state=idle|used}` and
 * `db.client.connection.max` for `pool` at each collection, labelled
 * `db.client.connection.pool.name` = `name`. Name it `host/database`: never
 * the user or anything from the password. `max` defaults to the pool's own
 * `options.max`, else 10 (node-postgres' default).
 */
export const registerPoolGauges = (
  pool: PoolLike,
  name: string,
  max?: number,
): void => {
  registerSource((out) => {
    const size = pool.totalCount;
    const idle = Math.min(pool.idleCount, size);
    const attrs = (state: string) => ({
      'db.client.connection.pool.name': name,
      'db.client.connection.state': state,
    });
    out.push({
      name: 'db.client.connection.count',
      value: size - idle,
      attrs: attrs('used'),
    });
    out.push({
      name: 'db.client.connection.count',
      value: idle,
      attrs: attrs('idle'),
    });
    out.push({
      name: 'db.client.connection.max',
      value: max ?? pool.options?.max ?? 10,
      attrs: { 'db.client.connection.pool.name': name },
    });
  });
};
