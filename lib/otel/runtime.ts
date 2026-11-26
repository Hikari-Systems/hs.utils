/**
 * Node.js runtime gauges, under the OpenTelemetry semantic-convention names
 * (`v8js.*`, `nodejs.eventloop.*`): the Node counterpart of the Rust
 * services' tokio runtime gauges.
 */
import { getHeapSpaceStatistics } from 'v8';
import {
  EventLoopUtilization,
  IntervalHistogram,
  monitorEventLoopDelay,
  performance,
} from 'perf_hooks';
import type { GaugeSource, Sample } from './metrics';

const NS = 1e9;

export const source = (): GaugeSource => {
  let delay: IntervalHistogram | undefined;
  try {
    delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
  } catch {
    delay = undefined;
  }
  let lastElu: EventLoopUtilization | undefined;

  return (out: Sample[]) => {
    const push = (name: string, value: number, attrs?: Sample['attrs']) =>
      out.push({ name, value, attrs });

    getHeapSpaceStatistics().forEach((s) => {
      const attrs = { 'v8js.heap.space.name': s.space_name };
      push('v8js.memory.heap.used', s.space_used_size, attrs);
      push('v8js.memory.heap.limit', s.space_size, attrs);
      push(
        'v8js.memory.heap.space.available_size',
        s.space_available_size,
        attrs,
      );
      push(
        'v8js.memory.heap.space.physical_size',
        s.physical_space_size,
        attrs,
      );
    });

    // Since the last collection: the histogram is reset after each read. No
    // samples (the loop was blocked the whole time, or none yet): no reading.
    if (delay && delay.count > 0) {
      push('nodejs.eventloop.delay.min', delay.min / NS);
      push('nodejs.eventloop.delay.max', delay.max / NS);
      push('nodejs.eventloop.delay.mean', delay.mean / NS);
      push('nodejs.eventloop.delay.stddev', delay.stddev / NS);
      push('nodejs.eventloop.delay.p50', delay.percentile(50) / NS);
      push('nodejs.eventloop.delay.p90', delay.percentile(90) / NS);
      push('nodejs.eventloop.delay.p99', delay.percentile(99) / NS);
      delay.reset();
    }

    const elu = performance.eventLoopUtilization();
    push('nodejs.eventloop.time', elu.active / 1000, {
      'nodejs.eventloop.state': 'active',
    });
    push('nodejs.eventloop.time', elu.idle / 1000, {
      'nodejs.eventloop.state': 'idle',
    });
    if (lastElu) {
      const d = performance.eventLoopUtilization(elu, lastElu);
      push('nodejs.eventloop.utilization', d.utilization);
    }
    lastElu = elu;
  };
};
