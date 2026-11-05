import { describe, expect, it } from 'vitest';
import { GpuTimer } from './GpuTimer';

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT = 0x8866;
const QUERY_RESULT_AVAILABLE = 0x8867;

/** A WebGL2 stand-in with the timer extension: each query's result is its ordinal × 1 ms, available once `finish` says so. */
function fakeGl() {
  let next = 0;
  let disjoint = false;
  const available = new Set<object>();
  const results = new Map<object, number>();
  const calls: string[] = [];
  const gl = {
    QUERY_RESULT,
    QUERY_RESULT_AVAILABLE,
    isContextLost: () => false,
    getExtension: () => ({ TIME_ELAPSED_EXT, GPU_DISJOINT_EXT }),
    createQuery: () => {
      calls.push('createQuery');
      return {};
    },
    deleteQuery: () => calls.push('deleteQuery'),
    beginQuery: (_target: number, query: object) => {
      calls.push('beginQuery');
      available.delete(query);
      results.set(query, ++next * 1e6);
    },
    endQuery: () => calls.push('endQuery'),
    getQueryParameter: (query: object, pname: number) => (pname === QUERY_RESULT_AVAILABLE ? available.has(query) : results.get(query)),
    getParameter: (pname: number) => {
      if (pname !== GPU_DISJOINT_EXT) return null;
      const was = disjoint;
      disjoint = false;
      return was;
    },
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    calls,
    /** Makes every query begun so far available. */
    finish: () => {
      for (const query of results.keys()) available.add(query);
    },
    disjoint: () => {
      disjoint = true;
    },
  };
}

describe('GpuTimer', () => {
  it('hands each finished frame its GPU time, oldest first', () => {
    const fake = fakeGl();
    const timer = new GpuTimer(fake.gl);
    for (let i = 0; i < 3; i++) {
      timer.begin();
      timer.end();
    }
    const times: number[] = [];
    timer.poll((ms) => times.push(ms));
    expect(times).toEqual([]);
    fake.finish();
    timer.poll((ms) => times.push(ms));
    expect(times).toEqual([1, 2, 3]);
  });

  it('drops every query in flight on a disjoint event, not just the first, and times frames again after it', () => {
    const fake = fakeGl();
    const timer = new GpuTimer(fake.gl);
    for (let i = 0; i < 4; i++) {
      timer.begin();
      timer.end();
    }
    fake.finish();
    fake.disjoint();
    const times: number[] = [];
    timer.poll((ms) => times.push(ms));
    expect(times).toEqual([]);
    // Nothing of the spoilt frames comes later either.
    timer.poll((ms) => times.push(ms));
    expect(times).toEqual([]);
    timer.begin();
    timer.end();
    fake.finish();
    timer.poll((ms) => times.push(ms));
    expect(times).toEqual([5]);
  });

  it('abandon() drops the queries without a WebGL call (they belong to a lost context)', () => {
    const fake = fakeGl();
    const timer = new GpuTimer(fake.gl);
    timer.begin();
    timer.end();
    timer.begin();
    const before = fake.calls.length;
    timer.abandon();
    timer.dispose();
    timer.poll(() => {
      throw new Error('no result after abandon()');
    });
    timer.begin();
    expect(fake.calls.length).toBe(before);
  });
});
