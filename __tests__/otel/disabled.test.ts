import express from 'express';
import request from 'supertest';
import { metrics, trace } from '@opentelemetry/api';
import * as otel from '../../lib/otel';
import { nextHop } from '../../test-support/otelHarness';

describe('otel disabled', () => {
  it('starts nothing and registers nothing globally', async () => {
    const providerBefore = trace.getTracerProvider();
    expect(otel.init({ config: { enabled: false } })).toBe(false);
    expect(otel.isEnabled()).toBe(false);
    expect(trace.getTracerProvider()).toBe(providerBefore);
    // The global meter provider is still the no-op one.
    expect(metrics.getMeterProvider().constructor.name).toBe(
      'NoopMeterProvider',
    );
    expect(otel.tracer().startSpan('x').isRecording()).toBe(false);
    expect(otel.clientSpan('smtp', 'send', 'relay').isRecording()).toBe(false);
    // A second init is ignored, even with export asked for.
    expect(
      otel.init({ config: { enabled: true, apiKeyRequired: false } }),
    ).toBe(false);
    await otel.shutdown();
  });

  it('leaves the middleware and fetch wrapper working, with no traceparent', async () => {
    const hop = await nextHop(200, { 'content-length': '2' }, 'ok');
    const app = express();
    app.use(otel.traceMiddleware());
    app.get('/api/items/:id', async (_req, res) => {
      const r = await otel.fetchTraced(`${hop.url}/next?x=1`);
      res.status(r.status).send(await r.text());
    });
    const res = await request(app).get('/api/items/7');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
    expect(hop.seen[0].headers.traceparent).toBeUndefined();
    await hop.close();
  });

  it('runs GenAI calls and client spans as no-ops', async () => {
    const call = otel.GenAiCall.start(
      otel.GENAI_OPERATION.CHAT,
      otel.GENAI_PROVIDER.OLLAMA,
      'llama',
      'test.task',
      true,
    );
    call.firstChunk();
    call.finish({ outputTokens: 3 });
    call.result('ok');
    call.end();
    await expect(
      otel.withClientSpan('redis', 'GET', 'redis', async () => 42),
    ).resolves.toBe(42);
  });
});

describe('otel without an api key', () => {
  it('stays off when the key is required', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fresh = require('../../lib/otel');
      expect(
        fresh.init({ config: { enabled: true, apiKey: '', serviceName: 's' } }),
      ).toBe(false);
    });
  });
});

describe('readOtelConfig', () => {
  const read = (env: Record<string, string>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let cfg: any;
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        cfg = require('../../lib/otel/config').readOtelConfig();
      });
    } finally {
      process.env = saved;
    }
    return cfg;
  };

  it('has the Rust OtelConfig defaults', () => {
    expect(read({})).toEqual({
      enabled: false,
      endpoint: 'https://api.honeycomb.io',
      apiKey: '',
      serviceName: '',
      environment: '',
      sampleRatio: 1,
      level: '',
      metricsEnabled: true,
      metricsIntervalSecs: 60,
      metricsDataset: '',
      processMetrics: true,
      apiKeyRequired: true,
      durationBuckets: otel.DURATION_BUCKETS,
    });
  });

  it('reads __ environment overrides, bucket list included', () => {
    const cfg = read({
      otel__enabled: 'true',
      otel__metricsIntervalSecs: '15',
      otel__apiKeyRequired: 'false',
      otel__durationBuckets: '0.1, 1, 10',
    });
    expect(cfg).toMatchObject({
      enabled: true,
      metricsIntervalSecs: 15,
      apiKeyRequired: false,
      durationBuckets: [0.1, 1, 10],
    });
    expect(() => read({ otel__durationBuckets: '1,0.5' })).toThrow(
      /durationBuckets/,
    );
  });
});
