import express from 'express';
import request from 'supertest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import * as otel from '../../lib/otel';
import {
  TestReader,
  has,
  nextHop,
  points,
} from '../../test-support/otelHarness';

const spans = new InMemorySpanExporter();
const reader = new TestReader();

const INBOUND_TRACE = '0af7651916cd43dd8448eb211c80319c';
const INBOUND = `00-${INBOUND_TRACE}-b7ad6b7169203331-01`;

let hop: Awaited<ReturnType<typeof nextHop>>;
let app: express.Express;

beforeAll(async () => {
  expect(
    otel.init({
      config: {
        enabled: true,
        apiKeyRequired: false,
        serviceName: 'test-service',
        environment: 'test',
        level: 'info',
      },
      spanExporter: spans,
      metricReader: reader,
    }),
  ).toBe(true);
  otel.setPathRedactor((p) => p.replace(/^\/hooks\/[^/]+/, '/hooks/{token}'));
  otel.setQuietPaths(['/jobs/claim']);
  hop = await nextHop();

  app = express();
  app.use(otel.traceMiddleware());
  app.get('/api/items/:id', (_req, res) => {
    res.send('ok');
  });
  app.get('/api/oauth2/callback', (_req, res) => {
    res.send('ok');
  });
  app.get('/hooks/:token/run', (_req, res) => {
    res.send('ok');
  });
  app.get('/boom', (_req, res) => {
    res.status(500).send('no');
  });
  const nested = express.Router();
  nested.get('/fail', () => {
    throw new Error('db down');
  });
  app.use('/nested', nested);
  const call = async (_req: express.Request, res: express.Response) => {
    await otel.withClientSpan('redis', 'GET', 'redis-host', async () => {
      await otel.fetchTraced(`${hop.url}/next`);
    });
    res.send('ok');
  };
  app.get('/healthcheck', call);
  app.get('/jobs/claim', call);
  app.get('/api/call', call);
  app.use(otel.traceErrorMiddleware());
});

afterAll(async () => {
  await hop.close();
  await otel.shutdown();
});

beforeEach(() => {
  spans.reset();
  hop.seen.length = 0;
});

const finished = () => spans.getFinishedSpans();
const server = (name: string) =>
  finished().find((s) => s.name === name && s.kind === SpanKind.SERVER);

describe('traceMiddleware', () => {
  it('names the span by the route template and adopts the traceparent', async () => {
    await request(app)
      .get('/api/items/abc-123?x=1')
      .set('traceparent', INBOUND)
      .set('user-agent', 'probe/1.0')
      .expect(200);
    const s = server('GET /api/items/:id');
    expect(s).toBeDefined();
    expect(finished().some((f) => f.name.includes('abc-123'))).toBe(false);
    expect(s!.spanContext().traceId).toBe(INBOUND_TRACE);
    expect(s!.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
    expect(s!.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/api/items/:id',
      'url.path': '/api/items/abc-123',
      'url.query': 'x=<redacted>',
      'http.response.status_code': 200,
      'network.protocol.version': 'HTTP/1.1',
      'user_agent.original': 'probe/1.0',
    });
    expect(s!.instrumentationScope.name).toBe('test-service');
    expect(s!.resource.attributes['service.name']).toBe('test-service');
    expect(s!.resource.attributes['deployment.environment.name']).toBe('test');
  });

  it('redacts query values', async () => {
    await request(app)
      .get('/api/oauth2/callback?code=ory_ac_live_9f3&state=csrf-1')
      .expect(200);
    const s = server('GET /api/oauth2/callback')!;
    expect(JSON.stringify(s.attributes)).not.toContain('ory_ac_live_9f3');
    expect(s.attributes['url.query']).toBe('code=<redacted>&state=<redacted>');
  });

  it('runs url.path through the path redactor', async () => {
    await request(app).get('/hooks/SECRET-TOKEN/run').expect(200);
    const s = server('GET /hooks/:token/run')!;
    expect(s.attributes['url.path']).toBe('/hooks/{token}/run');
  });

  it('collapses unmatched paths and marks only 5xx as errors', async () => {
    await request(app)
      .get(`/${'A'.repeat(4000)}`)
      .expect(404);
    await request(app).get('/boom').expect(500);
    await request(app).get('/nested/fail').expect(500);
    const unmatched = server('GET <unmatched>')!;
    expect(unmatched.status.code).toBe(SpanStatusCode.UNSET);
    expect(
      Buffer.byteLength(String(unmatched.attributes['url.path'])),
    ).toBeLessThanOrEqual(otel.MAX_ATTR_LEN + 3);
    expect(server('GET /boom')!.status.code).toBe(SpanStatusCode.ERROR);
    const failed = server('GET /nested/fail')!;
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes['http.route']).toBe('/nested/fail');
    expect(failed.events.map((e) => e.name)).toContain('request failed');
  });

  it('passes the trace on through clientSpan and fetchTraced', async () => {
    await request(app).get('/api/call').set('traceparent', INBOUND).expect(200);
    const s = server('GET /api/call')!;
    const redis = finished().find((f) => f.name === 'redis GET')!;
    const http = finished().find((f) => f.name === 'GET 127.0.0.1')!;
    expect(redis.parentSpanContext?.spanId).toBe(s.spanContext().spanId);
    expect(redis.attributes).toMatchObject({
      'client.system': 'redis',
      'client.operation': 'GET',
      'server.address': 'redis-host',
      'db.system.name': 'redis',
      'db.operation.name': 'GET',
      'client.outcome': 'ok',
    });
    expect(http.parentSpanContext?.spanId).toBe(redis.spanContext().spanId);
    expect(hop.seen[0].headers.traceparent).toBe(
      `00-${INBOUND_TRACE}-${http.spanContext().spanId}-01`,
    );
  });

  it('exports nothing of a quiet path but still counts it', async () => {
    await request(app)
      .get('/healthcheck')
      .set('traceparent', INBOUND)
      .expect(200);
    await request(app).get('/jobs/claim').expect(200);
    expect(finished()).toEqual([]);
    // The next hop is told not to sample, on a trace of its own.
    hop.seen.forEach((h) => {
      expect(h.headers.traceparent).toMatch(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/,
      );
      expect(h.headers.traceparent).not.toContain(INBOUND_TRACE);
    });
    expect(hop.seen).toHaveLength(2);
    const p = await points(reader);
    expect(
      has(p, 'http.server.request.duration', { 'http.route': '/healthcheck' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      has(p, 'hs.client.operation.duration', {
        'client.system': 'redis',
        'client.outcome': 'ok',
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('records the server metrics, as the Rust services do', async () => {
    await request(app).get('/api/items/1').expect(200);
    await request(app).get('/boom').expect(500);
    const p = await points(reader);
    const duration = p.find(
      (x) =>
        x.name === 'http.server.request.duration' &&
        x.attrs['http.route'] === '/boom',
    )!;
    expect(duration).toMatchObject({
      unit: 's',
      scope: 'hs-utils',
      attrs: {
        'http.request.method': 'GET',
        'http.route': '/boom',
        'http.response.status_code': '500',
      },
      boundaries: [...otel.DURATION_BUCKETS],
    });
    expect(
      has(p, 'http.server.request.duration', {
        'http.route': '/api/items/:id',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      has(p, 'http.server.request.duration', { 'http.route': '<unmatched>' }),
    ).toBeGreaterThanOrEqual(1);
    const active = p.find(
      (x) =>
        x.name === 'http.server.active_requests' &&
        x.attrs['http.request.method'] === 'GET',
    )!;
    expect(active).toMatchObject({ unit: '{request}', value: 0 });
    expect(
      has(p, 'http.client.request.duration', {
        'server.address': '127.0.0.1',
        'http.response.status_code': '204',
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('reports process and runtime gauges at collection', async () => {
    const p = await points(reader);
    const names = new Set(p.map((x) => x.name));
    ['v8js.memory.heap.used', 'nodejs.eventloop.time'].forEach((n) =>
      expect(names).toContain(n),
    );
    if (process.platform === 'linux') {
      const rss = p.find((x) => x.name === 'process.memory.usage');
      expect(rss?.value).toBeGreaterThan(0);
      expect(rss?.unit).toBe('By');
      const cpu = p.find((x) => x.name === 'process.cpu.time');
      expect(cpu?.monotonic).toBe(true);
    }
    p.forEach((x) => expect(x.scope).toBe('hs-utils'));
  });
});

describe('GenAiCall', () => {
  it('becomes a span and token, latency and cost metrics', async () => {
    const call = otel.GenAiCall.start(
      otel.GENAI_OPERATION.CHAT,
      otel.GENAI_PROVIDER.OPENROUTER,
      'some/model',
      'graph.extract',
      true,
    );
    call.maxTokens(4096);
    await call.run(async () => {
      call.firstChunk();
    });
    call.finish({
      inputTokens: 5000,
      outputTokens: 200,
      costUsd: 0.25,
      upstreamProvider: 'SomeHost',
    });
    call.result('ok');
    call.end();
    const failed = otel.GenAiCall.start(
      otel.GENAI_OPERATION.CHAT,
      otel.GENAI_PROVIDER.ANTHROPIC,
      'model-x',
      'chat.turn',
      false,
    );
    failed.fail('throttled');
    failed.end();
    otel.GenAiCall.start('chat', 'openai', 'model-y', 'dropped', false).end();

    const s = finished().find((f) => f.name === 'chat some/model')!;
    expect(s.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openrouter',
      'gen_ai.request.model': 'some/model',
      'gen_ai.request.stream': true,
      'gen_ai.request.max_tokens': 4096,
      'gen_ai.usage.input_tokens': 5000,
      'gen_ai.usage.output_tokens': 200,
      'hs.gen_ai.task': 'graph.extract',
      'hs.gen_ai.result': 'ok',
      'hs.gen_ai.cost_usd': 0.25,
      'hs.gen_ai.upstream_provider': 'SomeHost',
    });
    expect(s.attributes['gen_ai.response.time_to_first_chunk']).toBeDefined();
    expect(s.attributes['error.type']).toBeUndefined();
    expect(
      finished().find((f) => f.name === 'chat model-y')!.attributes[
        'error.type'
      ],
    ).toBe('cancelled');

    const p = await points(reader);
    ['input', 'output'].forEach((kind) =>
      expect(
        has(p, 'gen_ai.client.token.usage', {
          'gen_ai.token.type': kind,
          'hs.gen_ai.task': 'graph.extract',
          'gen_ai.request.stream': 'true',
        }),
      ).toBe(1),
    );
    expect(
      has(p, 'gen_ai.client.operation.time_to_first_chunk', {
        'hs.gen_ai.task': 'graph.extract',
      }),
    ).toBe(1);
    expect(
      has(p, 'hs.gen_ai.client.cost', { 'hs.gen_ai.task': 'graph.extract' }),
    ).toBe(0.25);
    expect(
      has(p, 'gen_ai.client.operation.duration', { 'error.type': 'throttled' }),
    ).toBe(1);
    expect(
      has(p, 'gen_ai.client.token.usage', { 'hs.gen_ai.task': 'chat.turn' }),
    ).toBeUndefined();
    expect(p.some((x) => 'hs.gen_ai.upstream_provider' in x.attrs)).toBe(false);
  });
});

describe('clientSpan', () => {
  it('feeds hs.client.operation.duration by outcome', async () => {
    const lock = otel.clientSpan('postgresql', 'lock.acquire', 'db');
    otel.recordOutcome(lock, 'busy');
    lock.end();
    const smtp = otel.clientSpan('smtp', 'send', 'relay.example.com');
    otel.recordError(smtp, new Error('refused'));
    smtp.end();
    smtp.end();
    const p = await points(reader);
    expect(
      has(p, 'hs.client.operation.duration', { 'client.outcome': 'busy' }),
    ).toBe(1);
    expect(
      has(p, 'hs.client.operation.duration', {
        'client.system': 'smtp',
        'client.outcome': 'error',
      }),
    ).toBe(1);
    const s = finished().find((f) => f.name === 'smtp send')!;
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.attributes['db.system.name']).toBeUndefined();
    expect(s.events[0].name).toBe('client failed');
  });
});
