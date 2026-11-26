import { SlidingWindowLimiter } from './sliding-window-limiter';

describe('SlidingWindowLimiter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('allows up to max hits per key, then rejects', () => {
    const l = new SlidingWindowLimiter(() => 2, 1000);
    expect(l.tryConsume('a')).toBe(true);
    expect(l.tryConsume('a')).toBe(true);
    expect(l.tryConsume('a')).toBe(false);
    expect(l.tryConsume('b')).toBe(true);
  });

  it('frees capacity once hits age out of the window', () => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const l = new SlidingWindowLimiter(() => 1, 1000);
    expect(l.tryConsume('a')).toBe(true);
    expect(l.tryConsume('a')).toBe(false);
    now += 1001;
    expect(l.tryConsume('a')).toBe(true);
  });

  it('reads the max at call time and rejects when it is NaN', () => {
    let max = 1;
    const l = new SlidingWindowLimiter(() => max, 1000);
    expect(l.tryConsume('a')).toBe(true);
    max = NaN;
    expect(l.tryConsume('a')).toBe(false);
  });

  it('does not retain keys that are rejected with an empty window', () => {
    const l = new SlidingWindowLimiter(() => 0, 1000);
    expect(l.tryConsume('a')).toBe(false);
    expect((l as unknown as { hits: Map<string, number[]> }).hits.size).toBe(0);
  });
});
