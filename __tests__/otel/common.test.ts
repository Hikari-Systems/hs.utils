import {
  BoundedLabels,
  MAX_ATTR_LEN,
  MAX_METRIC_PEERS,
  peerLabels,
  pinMatches,
  redactQuery,
  sessionRecordingId,
  truncate,
} from '../../lib/otel/common';
import { levelRank } from '../../lib/otel/state';

describe('otel common', () => {
  it('redacts every query value and replaces a bare token whole', () => {
    expect(redactQuery('code=ory_ac_live_9f3&state=csrf-1')).toBe(
      'code=<redacted>&state=<redacted>',
    );
    expect(redactQuery('a=1&sometoken&=x')).toBe(
      'a=<redacted>&<redacted>&<redacted>',
    );
    expect(redactQuery('')).toBe('');
    expect(redactQuery(undefined)).toBe('');
    const long = redactQuery(
      Array.from({ length: 200 }, (_, i) => `p${i}=v`).join('&'),
    );
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(MAX_ATTR_LEN + 3);
  });

  it('truncates by UTF-8 bytes without splitting a code point', () => {
    expect(truncate('short')).toBe('short');
    const t = truncate('é'.repeat(200), 255);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toContain('�');
    expect(Buffer.byteLength(t.slice(0, -1))).toBeLessThanOrEqual(255);
  });

  it('matches pins as exact hosts and dot suffixes', () => {
    expect(pinMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(pinMatches('api.example.com', 'x.api.example.com')).toBe(false);
    expect(pinMatches('.example.com', 'example.com')).toBe(true);
    expect(pinMatches('.example.com', 'a.b.example.com')).toBe(true);
    expect(pinMatches('.example.com', 'notexample.com')).toBe(false);
  });

  it('bounds the peer label: dotless always, then the first N dotted hosts', () => {
    const labels = peerLabels();
    expect(labels.label('user-data-service')).toBe('user-data-service');
    expect(labels.label('')).toBe('');
    for (let i = 0; i < MAX_METRIC_PEERS; i += 1)
      expect(labels.label(`site${i}.example.org`)).toBe(`site${i}.example.org`);
    expect(labels.label('one-more.example.org')).toBe('other');
    expect(labels.label('site0.example.org')).toBe('site0.example.org');
    expect(labels.label('another-service')).toBe('another-service');
    const models = new BoundedLabels(2);
    expect([models.label('a'), models.label('b'), models.label('c')]).toEqual([
      'a',
      'b',
      'other',
    ]);
  });

  it('keeps only UUID session recording ids', () => {
    expect(sessionRecordingId('0b8f2a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b')).toBe(
      '0b8f2a3c-1d2e-4f50-9a6b-7c8d9e0f1a2b',
    );
    expect(sessionRecordingId('not-a-uuid')).toBeUndefined();
    expect(sessionRecordingId(undefined)).toBeUndefined();
  });

  it('ranks export levels by their default directive', () => {
    expect(levelRank('info')).toBe(levelRank('info,some::target=debug'));
    expect(levelRank('debug')).toBeLessThan(levelRank('info'));
    expect(levelRank('')).toBe(levelRank('info'));
    expect(levelRank('warn')).toBeGreaterThan(levelRank('info'));
  });
});
