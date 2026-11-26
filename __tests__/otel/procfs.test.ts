import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseBytes,
  parseCpuMax,
  parseCpuStat,
  parseIo,
  parseMemoryEvents,
  parsePressure,
  parseStat,
  parseStatus,
  readContainerMemoryUsage,
  source,
} from '../../lib/otel/procfs';
import { CATALOG, Sample } from '../../lib/otel/metrics';

/**
 * A real /proc/self/stat line, with a command name containing `) (` to prove
 * fields are counted from the last parenthesis.
 */
const STAT =
  '4242 (my) (svc) S 1 4242 4242 0 -1 4194560 2735 0 0 0 ' +
  '150 75 0 0 20 0 9 0 12345 123456789 2048 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 ' +
  '37 0 0 0 0 0 0 0 0 0';

describe('procfs parsers', () => {
  it('counts stat fields from the last parenthesis', () => {
    expect(parseStat(STAT)).toEqual({
      userSecs: 1.5,
      systemSecs: 0.75,
      blkioDelaySecs: 0.37,
    });
  });

  it('has no blkio delay on a short stat line', () => {
    expect(parseStat('1 (x) S 1 1 1 0 -1 0 0 0 0 0 10 20')).toEqual({
      userSecs: 0.1,
      systemSecs: 0.2,
      blkioDelaySecs: undefined,
    });
    expect(parseStat('garbage')).toBeUndefined();
  });

  it('reads status sizes as kilobytes', () => {
    expect(
      parseStatus(
        'Name:\tsvc\nVmSize:\t  204800 kB\nVmRSS:\t   51200 kB\nThreads:\t9\n',
      ),
    ).toEqual({
      rssBytes: 51200 * 1024,
      virtualBytes: 204800 * 1024,
      threads: 9,
    });
  });

  it('reports storage bytes, not page cache', () => {
    expect(
      parseIo(
        'rchar: 999999\nwchar: 888888\nread_bytes: 4096\nwrite_bytes: 8192\n',
      ),
    ).toEqual({ readBytes: 4096, writeBytes: 8192 });
  });

  it('reads the cgroup cpu files', () => {
    expect(
      parseCpuStat(
        'usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\nnr_periods 10\nnr_throttled 3\nthrottled_usec 120000\n',
      ),
    ).toEqual({ usageSecs: 2.5, throttledSecs: 0.12, nrThrottled: 3 });
    expect(parseCpuMax('150000 100000\n')).toBe(1.5);
    expect(parseCpuMax('max 100000\n')).toBeUndefined();
  });

  it('treats memory.max of max as no limit', () => {
    expect(parseBytes('536870912\n')).toBe(536870912);
    expect(parseBytes('max\n')).toBeUndefined();
  });

  it('parses pressure lines', () => {
    expect(
      parsePressure(
        'some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=4.25 avg60=1.00 avg300=0.50 total=45\n',
      ),
    ).toEqual([
      ['some', 12.5],
      ['full', 4.25],
    ]);
  });

  it('parses memory.events oom and oom_kill', () => {
    expect(
      parseMemoryEvents(
        'low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\noom_group_kill 0\n',
      ),
    ).toEqual({ oom: 3, oomKill: 2 });
    expect(parseMemoryEvents('low 0\nhigh 0\n')).toEqual({});
  });
});

describe('procfs source', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-utils-procfs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Every reading named as the catalog expects, and a missing file simply
   * absent rather than zero.
   */
  it('reads a fixture tree', () => {
    const procSelf = join(dir, 'proc');
    const cgroup = join(dir, 'cg');
    mkdirSync(join(procSelf, 'fd'), { recursive: true });
    mkdirSync(cgroup, { recursive: true });
    writeFileSync(join(procSelf, 'stat'), STAT);
    writeFileSync(join(procSelf, 'status'), 'VmRSS:\t100 kB\n');
    writeFileSync(join(procSelf, 'fd', '0'), '');
    writeFileSync(
      join(cgroup, 'io.pressure'),
      'some avg10=7.00 avg60=0 avg300=0 total=1\n',
    );
    writeFileSync(join(cgroup, 'memory.max'), 'max\n');
    writeFileSync(join(cgroup, 'memory.current'), '1048576\n');
    writeFileSync(
      join(cgroup, 'memory.events'),
      'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
    );

    const src = source({ procSelf, cgroup });
    const out: Sample[] = [];
    src(out);
    src(out); // a second collection yields the utilisation gauge

    const names = out.map((s) => s.name);
    [
      'process.cpu.time',
      'hs.process.blkio_delay',
      'process.memory.usage',
      'process.open_file_descriptor.count',
      'hs.container.pressure',
      'process.cpu.utilization',
      'container.memory.usage',
      'hs.container.memory.oom_kills',
      'hs.container.memory.oom_events',
    ].forEach((want) => expect(names).toContain(want));
    expect(names).not.toContain('hs.container.memory.limit');
    expect(names).not.toContain('process.disk.io');
    expect(names).not.toContain('container.cpu.time');

    const io = out.find((s) => s.name === 'hs.container.pressure')!;
    expect(io.value).toBe(7);
    expect(io.attrs).toEqual({ resource: 'io', kind: 'some' });
    // A real zero is reported as zero: the counter exists, nothing was killed.
    expect(
      out.find((s) => s.name === 'hs.container.memory.oom_kills')?.value,
    ).toBe(0);
    expect(out.find((s) => s.name === 'process.memory.usage')?.value).toBe(
      102400,
    );
    expect(
      out
        .filter((s) => s.name === 'process.cpu.time')
        .slice(0, 2)
        .map((s) => s.attrs),
    ).toEqual([{ 'cpu.mode': 'user' }, { 'cpu.mode': 'system' }]);
    expect(readContainerMemoryUsage(cgroup)).toBe(1048576);
  });

  it('reports nothing from an empty tree', () => {
    const out: Sample[] = [];
    source({ procSelf: join(dir, 'none'), cgroup: join(dir, 'none') })(out);
    expect(out).toEqual([]);
    expect(readContainerMemoryUsage(join(dir, 'none'))).toBeUndefined();
  });

  it('only reports catalogued names', () => {
    const catalogued = new Set(CATALOG.map(([name]) => name));
    const procSelf = join(dir, 'proc');
    mkdirSync(join(procSelf, 'fd'), { recursive: true });
    writeFileSync(join(procSelf, 'stat'), STAT);
    const out: Sample[] = [];
    source({ procSelf, cgroup: dir })(out);
    out.forEach((s) => expect(catalogued.has(s.name)).toBe(true));
  });
});
