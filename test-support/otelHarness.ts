import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import {
  DataPointType,
  MetricReader,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

/** A metric reader that collects only when asked. */
export class TestReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}

  protected async onForceFlush(): Promise<void> {}
}

/** One exported data point: value for sums and gauges, count for histograms. */
export interface Point {
  name: string;
  unit: string;
  scope: string;
  kind: DataPointType;
  monotonic?: boolean;
  value: number;
  boundaries?: number[];
  attrs: Record<string, string>;
}

export const flatten = (rm: ResourceMetrics): Point[] => {
  const out: Point[] = [];
  rm.scopeMetrics.forEach((sm) =>
    sm.metrics.forEach((m) =>
      (m.dataPoints as any[]).forEach((p) => {
        const attrs: Record<string, string> = {};
        Object.entries(p.attributes).forEach(([k, v]) => {
          attrs[k] = String(v);
        });
        out.push({
          name: m.descriptor.name,
          unit: m.descriptor.unit,
          scope: sm.scope.name,
          kind: m.dataPointType,
          monotonic: (m as any).isMonotonic,
          value:
            m.dataPointType === DataPointType.HISTOGRAM
              ? p.value.count
              : p.value,
          boundaries:
            m.dataPointType === DataPointType.HISTOGRAM
              ? p.value.buckets.boundaries
              : undefined,
          attrs,
        });
      }),
    ),
  );
  return out;
};

export const points = async (reader: TestReader): Promise<Point[]> =>
  flatten((await reader.collect()).resourceMetrics);

/** The value of the point `name` carrying every attribute in `attrs`. */
export const has = (
  ps: Point[],
  name: string,
  attrs: Record<string, string>,
): number | undefined =>
  ps.find(
    (p) =>
      p.name === name &&
      Object.entries(attrs).every(([k, v]) => p.attrs[k] === v),
  )?.value;

/**
 * A local HTTP server answering every request with `status` (and `headers`),
 * remembering the request heads it was sent.
 */
export const nextHop = async (
  status = 204,
  headers: Record<string, string> = {},
  body = '',
): Promise<{
  url: string;
  seen: { url: string; headers: IncomingHttpHeaders }[];
  close: () => Promise<void>;
}> => {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(status, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
