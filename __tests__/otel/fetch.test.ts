import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
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

beforeAll(() => {
  otel.init({
    config: {
      enabled: true,
      apiKeyRequired: false,
      serviceName: 'test-service',
      level: 'info',
    },
    spanExporter: spans,
    metricReader: reader,
  });
});

afterAll(() => otel.shutdown());
beforeEach(() => spans.reset());

const only = (name: string) => {
  const found = spans.getFinishedSpans().filter((s) => s.name === name);
  expect(found).toHaveLength(1);
  return found[0];
};

describe('fetchTraced', () => {
  it('sends traceparent, records the status and redacts query values', async () => {
    const hop = await nextHop(503, { 'content-length': '0' });
    const port = new URL(hop.url).port;
    const parent = otel.tracer().startSpan('caller');
    const res = await context.with(
      trace.setSpan(context.active(), parent),
      () =>
        otel.fetchTraced(
          `${hop.url}/admin/identities/abc?token=SECRET_TOKEN&page=2`,
          { headers: { 'x-api-key': 'k' } },
        ),
    );
    parent.end();
    await hop.close();
    expect(res.status).toBe(503);

    const s = only('GET 127.0.0.1');
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(s.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(s.attributes).toMatchObject({
      'http.request.method': 'GET',
      'server.address': '127.0.0.1',
      'server.port': Number(port),
      'url.full': `http://127.0.0.1:${port}/admin/identities/abc?token=<redacted>&page=<redacted>`,
      'http.response.status_code': 503,
      'http.response.body.size': 0,
      'hs.http.response.body.compressed': false,
      'hs.http.response.body.size_source': 'header',
    });
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(s.attributes)).not.toContain('SECRET_TOKEN');

    const sent = hop.seen[0].headers;
    expect(sent['x-api-key']).toBe('k');
    expect(sent.traceparent).toBe(
      `00-${parent.spanContext().traceId}-${s.spanContext().spanId}-01`,
    );

    const p = await points(reader);
    expect(
      has(p, 'http.client.request.duration', {
        'http.request.method': 'GET',
        'server.address': '127.0.0.1',
        'http.response.status_code': '503',
      }),
    ).toBe(1);
    expect(
      has(p, 'http.client.response.body.size', {
        'hs.http.response.body.compressed': 'false',
      }),
    ).toBe(1);
  });

  it('records only the origin for an opaque URL', async () => {
    const hop = await nextHop(204);
    await otel.fetchTracedOpaque(`${hop.url}/services/T000/B000/SECRET?x=1`, {
      method: 'post',
      body: '{}',
    });
    await hop.close();
    const s = only('POST 127.0.0.1');
    expect(s.attributes['url.full']).toBe(hop.url);
    expect(JSON.stringify(s.attributes)).not.toContain('SECRET');
    expect(hop.seen[0].headers.traceparent).toMatch(/^00-[0-9a-f]{32}-/);
    expect(s.attributes['http.response.body.size']).toBeUndefined();
  });

  it('records a template path in place of the real one', async () => {
    const hop = await nextHop(200, { 'content-length': '2' }, 'ok');
    const req = new Request(`${hop.url}/api/session/SESSION_SECRET?ttl=1`);
    const res = await otel.fetchTracedWith(req, undefined, {
      path: '/api/session/{id}',
    });
    expect(await res.text()).toBe('ok');
    await hop.close();
    expect(only('GET 127.0.0.1').attributes['url.full']).toBe(
      `${hop.url}/api/session/{id}?ttl=<redacted>`,
    );
  });

  it('keeps a debug call out of the export but counts it', async () => {
    const hop = await nextHop(200);
    await otel.fetchTracedWith(`${hop.url}/poll`, undefined, {
      level: 'debug',
    });
    await hop.close();
    expect(spans.getFinishedSpans()).toEqual([]);
    // No trace around it: the far end is told not to sample.
    expect(hop.seen[0].headers.traceparent).toMatch(/-00$/);
    const p = await points(reader);
    expect(
      has(p, 'http.client.request.duration', {
        'http.response.status_code': '200',
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('records a failed connection as no_response', async () => {
    const hop = await nextHop();
    const { url } = hop;
    await hop.close();
    await expect(otel.fetchTraced(`${url}/gone`)).rejects.toThrow();
    const s = only('GET 127.0.0.1');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.events[0]).toMatchObject({
      name: 'http.client failed',
      attributes: { error: 'connect' },
    });
    const p = await points(reader);
    expect(
      has(p, 'http.client.request.duration', { 'error.type': 'no_response' }),
    ).toBe(1);
  });
});
