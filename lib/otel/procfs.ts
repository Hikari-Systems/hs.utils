/**
 * Process and container resource readings from `/proc/self` and the cgroup
 * v2 files of the container this process runs in.
 *
 * Pure parsers over file contents plus a gauge source that reads the files at
 * collection time. Every file is optional: a missing one (not Linux, cgroup
 * v1, delay accounting off) just means those samples are not reported, never
 * an error and never a zero that looks like a reading.
 *
 * `hs.container.pressure{resource=io}` is the cgroup's pressure stall
 * information: the share of wall time some task in this container was
 * stalled on I/O, i.e. the per-container iowait. `hs.process.blkio_delay` is
 * this process's cumulative time blocked on block I/O (needs the kernel's
 * delay accounting).
 */
import { readFileSync, readdirSync } from 'fs';
import { availableParallelism } from 'os';
import { join } from 'path';
import type { GaugeSource, Sample } from './metrics';

/**
 * `/proc/<pid>/stat` times are in clock ticks of `USER_HZ`, which is 100 on
 * every architecture Linux supports in practice (fixed by the ABI).
 */
const USER_HZ = 100;

/** A strict decimal number, or `undefined` (`"max"`, `""`, garbage). */
const num = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
  return Number(t);
};

export interface Stat {
  userSecs: number;
  systemSecs: number;
  /** `delayacct_blkio_ticks`; `undefined` when the line is too short. */
  blkioDelaySecs?: number;
}

/**
 * Parse `/proc/self/stat`. The command name (field 2) is in parentheses and
 * may itself contain spaces and `)`, so fields are counted from the LAST `)`.
 */
export const parseStat = (text: string): Stat | undefined => {
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  // Starts at field 3 (state), so field N is index N - 3.
  const f = text
    .slice(close + 1)
    .split(/\s+/)
    .filter((s) => s !== '');
  const field = (n: number) => num(f[n - 3]);
  const user = field(14);
  const system = field(15);
  if (user === undefined || system === undefined) return undefined;
  const delay = field(42);
  return {
    userSecs: user / USER_HZ,
    systemSecs: system / USER_HZ,
    blkioDelaySecs: delay === undefined ? undefined : delay / USER_HZ,
  };
};

export interface Status {
  rssBytes?: number;
  virtualBytes?: number;
  threads?: number;
}

/** `/proc/self/status`. Sizes there are in kB, so no page size is needed. */
export const parseStatus = (text: string): Status => {
  const s: Status = {};
  text.split('\n').forEach((line) => {
    const colon = line.indexOf(':');
    if (colon < 0) return;
    const key = line.slice(0, colon);
    const value = num(
      line
        .slice(colon + 1)
        .trim()
        .split(/\s+/)[0],
    );
    if (key === 'VmRSS' && value !== undefined) s.rssBytes = value * 1024;
    else if (key === 'VmSize' && value !== undefined)
      s.virtualBytes = value * 1024;
    else if (key === 'Threads' && value !== undefined) s.threads = value;
  });
  return s;
};

export interface Io {
  readBytes?: number;
  writeBytes?: number;
}

/**
 * `/proc/self/io`: bytes this process caused to be read from / written to
 * storage (not the page cache: `rchar`/`wchar` would count those).
 */
export const parseIo = (text: string): Io => {
  const io: Io = {};
  text.split('\n').forEach((line) => {
    const colon = line.indexOf(':');
    if (colon < 0) return;
    const key = line.slice(0, colon);
    const value = num(line.slice(colon + 1));
    if (value === undefined) return;
    if (key === 'read_bytes') io.readBytes = value;
    else if (key === 'write_bytes') io.writeBytes = value;
  });
  return io;
};

export interface CpuStat {
  usageSecs?: number;
  throttledSecs?: number;
  nrThrottled?: number;
}

/** cgroup v2 `cpu.stat`. */
export const parseCpuStat = (text: string): CpuStat => {
  const c: CpuStat = {};
  text.split('\n').forEach((line) => {
    const [key, raw] = line.trim().split(/\s+/);
    const value = num(raw);
    if (key === undefined || value === undefined) return;
    if (key === 'usage_usec') c.usageSecs = value / 1e6;
    else if (key === 'throttled_usec') c.throttledSecs = value / 1e6;
    else if (key === 'nr_throttled') c.nrThrottled = value;
  });
  return c;
};

/**
 * cgroup v2 `cpu.max` (`"<quota> <period>"` or `"max <period>"`) as a number
 * of CPUs. `undefined` for no limit.
 */
export const parseCpuMax = (text: string): number | undefined => {
  const [q, p] = text.trim().split(/\s+/);
  const quota = num(q);
  const period = num(p);
  if (quota === undefined || period === undefined || period <= 0)
    return undefined;
  return quota / period;
};

/** cgroup v2 `memory.max` / `memory.current`: a byte count, or `"max"`. */
export const parseBytes = (text: string): number | undefined => num(text);

/**
 * One PSI file (`cpu.pressure`, `memory.pressure`, `io.pressure`):
 * `some avg10=1.23 avg60=… avg300=… total=…`. Returns `[kind, avg10]` pairs:
 * the percentage of the last 10 s that some (or, for `full`, every) runnable
 * task in the cgroup was stalled on that resource.
 */
export const parsePressure = (text: string): [string, number][] => {
  const out: [string, number][] = [];
  text.split('\n').forEach((line) => {
    const [kind, ...rest] = line.trim().split(/\s+/);
    if (!kind) return;
    const avg = rest.find((kv) => kv.startsWith('avg10='));
    const value = num(avg?.slice('avg10='.length));
    if (value !== undefined) out.push([kind, value]);
  });
  return out;
};

export interface MemoryEvents {
  /** `oom`: times the limit was reached and the OOM killer invoked. */
  oom?: number;
  /** `oom_kill`: processes the OOM killer killed. */
  oomKill?: number;
}

/** cgroup v2 `memory.events` (`low 0\nhigh 0\nmax 3\noom 1\noom_kill 1`). */
export const parseMemoryEvents = (text: string): MemoryEvents => {
  const e: MemoryEvents = {};
  text.split('\n').forEach((line) => {
    const [key, raw] = line.trim().split(/\s+/);
    const value = num(raw);
    if (value === undefined) return;
    if (key === 'oom') e.oom = value;
    else if (key === 'oom_kill') e.oomKill = value;
  });
  return e;
};

/** Where to read from. Separate so tests can point it at a fixture tree. */
export interface Paths {
  procSelf: string;
  cgroup: string;
}

export const DEFAULT_PATHS: Paths = {
  procSelf: '/proc/self',
  // Inside a container with its own cgroup namespace (Docker's default on
  // cgroup v2), this is the container's cgroup.
  cgroup: '/sys/fs/cgroup',
};

const read = (dir: string, file: string): string | undefined => {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * The container's memory charge now (cgroup v2 `memory.current`), in bytes;
 * `undefined` where there is no such file. A synchronous read of one small
 * file: cheap enough to call per request.
 */
export const readContainerMemoryUsage = (
  cgroup = DEFAULT_PATHS.cgroup,
): number | undefined => {
  const t = read(cgroup, 'memory.current');
  return t === undefined ? undefined : parseBytes(t);
};

/** The gauge source for everything above. */
export const source = (paths: Paths = DEFAULT_PATHS): GaugeSource => {
  let last: { at: number; cpuSecs: number } | undefined;
  return (out: Sample[]) => {
    const push = (name: string, value: number, attrs?: Sample['attrs']) =>
      out.push({ name, value, attrs });
    const cg = paths.cgroup;
    const cpuMax = read(cg, 'cpu.max');
    const cpuLimit = cpuMax === undefined ? undefined : parseCpuMax(cpuMax);

    const statText = read(paths.procSelf, 'stat');
    const stat = statText === undefined ? undefined : parseStat(statText);
    if (stat) {
      push('process.cpu.time', stat.userSecs, { 'cpu.mode': 'user' });
      push('process.cpu.time', stat.systemSecs, { 'cpu.mode': 'system' });
      if (stat.blkioDelaySecs !== undefined)
        push('hs.process.blkio_delay', stat.blkioDelaySecs);
      // Share of the CPU this process may use: the container's quota when it
      // has one, else every CPU it can run on. 1.0 is "using all of it".
      const cpuSecs = stat.userSecs + stat.systemSecs;
      const now = performance.now();
      if (last) {
        const wall = (now - last.at) / 1000;
        const cpus = cpuLimit ?? availableParallelism() ?? 1;
        if (wall > 0 && cpus > 0) {
          const used = Math.max(cpuSecs - last.cpuSecs, 0);
          push('process.cpu.utilization', used / wall / cpus);
        }
      }
      last = { at: now, cpuSecs };
    }

    const statusText = read(paths.procSelf, 'status');
    if (statusText !== undefined) {
      const status = parseStatus(statusText);
      if (status.rssBytes !== undefined)
        push('process.memory.usage', status.rssBytes);
      if (status.virtualBytes !== undefined)
        push('process.memory.virtual', status.virtualBytes);
      if (status.threads !== undefined)
        push('process.thread.count', status.threads);
    }

    try {
      const fds = readdirSync(join(paths.procSelf, 'fd'));
      push('process.open_file_descriptor.count', fds.length);
    } catch {
      // no /proc: no reading
    }

    const ioText = read(paths.procSelf, 'io');
    if (ioText !== undefined) {
      const io = parseIo(ioText);
      if (io.readBytes !== undefined)
        push('process.disk.io', io.readBytes, { 'disk.io.direction': 'read' });
      if (io.writeBytes !== undefined)
        push('process.disk.io', io.writeBytes, {
          'disk.io.direction': 'write',
        });
    }

    // ── container (cgroup v2) ──
    const cpuStatText = read(cg, 'cpu.stat');
    if (cpuStatText !== undefined) {
      const cpu = parseCpuStat(cpuStatText);
      if (cpu.usageSecs !== undefined)
        push('container.cpu.time', cpu.usageSecs);
      if (cpu.throttledSecs !== undefined)
        push('hs.container.cpu.throttled_time', cpu.throttledSecs);
    }
    if (cpuLimit !== undefined) push('hs.container.cpu.limit', cpuLimit);
    const current = readContainerMemoryUsage(cg);
    if (current !== undefined) push('container.memory.usage', current);
    const maxText = read(cg, 'memory.max');
    const max = maxText === undefined ? undefined : parseBytes(maxText);
    if (max !== undefined) push('hs.container.memory.limit', max);
    const eventsText = read(cg, 'memory.events');
    if (eventsText !== undefined) {
      const events = parseMemoryEvents(eventsText);
      if (events.oomKill !== undefined)
        push('hs.container.memory.oom_kills', events.oomKill);
      if (events.oom !== undefined)
        push('hs.container.memory.oom_events', events.oom);
    }
    ['cpu', 'memory', 'io'].forEach((resource) => {
      const text = read(cg, `${resource}.pressure`);
      if (text === undefined) return;
      parsePressure(text).forEach(([kind, avg10]) =>
        push('hs.container.pressure', avg10, { resource, kind }),
      );
    });
  };
};
