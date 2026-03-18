import { describe, it, expect } from 'vitest';
import { clamp, vwap, weightedMid, bookDepthWithin, imbalance, multiLevelImbalance } from '../../src/utils/math.js';

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to min', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('handles min === max', () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

describe('vwap', () => {
  it('computes VWAP across multiple levels', () => {
    const asks: [number, number][] = [
      [0.50, 100],
      [0.51, 200],
      [0.52, 300],
    ];
    // Fill 250 units: 100 @ 0.50 + 150 @ 0.51
    const result = vwap(asks, 250);
    const expected = (100 * 0.50 + 150 * 0.51) / 250;
    expect(result).toBeCloseTo(expected, 10);
  });

  it('returns exact price when entire fill is at one level', () => {
    const asks: [number, number][] = [[0.60, 500]];
    expect(vwap(asks, 100)).toBeCloseTo(0.60, 10);
  });

  it('returns NaN if book has insufficient depth', () => {
    const asks: [number, number][] = [[0.50, 10]];
    expect(vwap(asks, 100)).toBeNaN();
  });

  it('returns NaN for zero target size', () => {
    expect(vwap([[0.50, 100]], 0)).toBeNaN();
  });

  it('returns NaN for negative target size', () => {
    expect(vwap([[0.50, 100]], -5)).toBeNaN();
  });

  it('handles empty book', () => {
    expect(vwap([], 100)).toBeNaN();
  });
});

describe('weightedMid (microprice)', () => {
  it('returns midpoint when bid and ask sizes are equal', () => {
    expect(weightedMid(0.48, 100, 0.52, 100)).toBeCloseTo(0.50, 10);
  });

  it('skews toward ask when bid size is larger', () => {
    // Large bid size → microprice moves toward ask (price expected to rise)
    const mp = weightedMid(0.48, 300, 0.52, 100);
    expect(mp).toBeGreaterThan(0.50);
    // micro = (100*0.48 + 300*0.52) / 400 = (48 + 156)/400 = 0.51
    expect(mp).toBeCloseTo(0.51, 10);
  });

  it('skews toward bid when ask size is larger', () => {
    const mp = weightedMid(0.48, 100, 0.52, 300);
    // micro = (300*0.48 + 100*0.52) / 400 = (144 + 52)/400 = 0.49
    expect(mp).toBeCloseTo(0.49, 10);
  });

  it('returns NaN when both sizes are zero', () => {
    expect(weightedMid(0.48, 0, 0.52, 0)).toBeNaN();
  });
});

describe('bookDepthWithin', () => {
  const bids: [number, number][] = [
    [0.50, 100],
    [0.495, 200],
    [0.49, 150],
    [0.48, 50],
    [0.45, 300],
  ];

  it('computes depth within 1% of best bid', () => {
    // 1% of 0.50 = 0.005 → levels at 0.50, 0.495 are within
    const depth = bookDepthWithin(bids, 0.01, 0.50);
    expect(depth).toBe(300); // 100 + 200
  });

  it('computes depth within 5% of best bid', () => {
    // 5% of 0.50 = 0.025 → levels at 0.50, 0.495, 0.49, 0.48 are within
    const depth = bookDepthWithin(bids, 0.05, 0.50);
    expect(depth).toBe(500); // 100 + 200 + 150 + 50
  });

  it('returns 0 for empty book', () => {
    expect(bookDepthWithin([], 0.01, 0.50)).toBe(0);
  });

  it('returns 0 for bestPrice <= 0', () => {
    expect(bookDepthWithin(bids, 0.01, 0)).toBe(0);
  });
});

describe('imbalance', () => {
  it('returns 0 when sides are equal', () => {
    expect(imbalance(100, 100)).toBe(0);
  });

  it('returns 1 when only bids exist', () => {
    expect(imbalance(100, 0)).toBe(1);
  });

  it('returns -1 when only asks exist', () => {
    expect(imbalance(0, 100)).toBe(-1);
  });

  it('returns 0 when both sides are empty', () => {
    expect(imbalance(0, 0)).toBe(0);
  });

  it('returns correct ratio for unequal sides', () => {
    // (300 - 100) / (300 + 100) = 200/400 = 0.5
    expect(imbalance(300, 100)).toBeCloseTo(0.5, 10);
  });
});

describe('multiLevelImbalance', () => {
  it('returns 0 for symmetric book', () => {
    const bids: [number, number][] = [[0.50, 100], [0.49, 100], [0.48, 100]];
    const asks: [number, number][] = [[0.51, 100], [0.52, 100], [0.53, 100]];
    expect(multiLevelImbalance(bids, asks, 3)).toBeCloseTo(0, 10);
  });

  it('returns positive when bids dominate', () => {
    const bids: [number, number][] = [[0.50, 500], [0.49, 500]];
    const asks: [number, number][] = [[0.51, 50], [0.52, 50]];
    expect(multiLevelImbalance(bids, asks, 2)).toBeGreaterThan(0);
  });

  it('returns 0 for empty book', () => {
    expect(multiLevelImbalance([], [], 5)).toBe(0);
  });

  it('handles fewer levels than requested', () => {
    // Only 1 level each, but requesting 5 — missing levels treated as 0
    const bids: [number, number][] = [[0.50, 100]];
    const asks: [number, number][] = [[0.51, 100]];
    // weight[0]=1 → weighted bid = 100, weighted ask = 100 → imbalance = 0
    expect(multiLevelImbalance(bids, asks, 5)).toBeCloseTo(0, 10);
  });

  it('weights top of book more heavily', () => {
    // Level 1: bids heavy. Level 2: asks heavy by a lot.
    // Because level 1 has weight 1 and level 2 has weight 0.5,
    // the bid-heavy top should dominate.
    const bids: [number, number][] = [[0.50, 200], [0.49, 10]];
    const asks: [number, number][] = [[0.51, 50], [0.52, 200]];
    // wBid = 200*1 + 10*0.5 = 205
    // wAsk = 50*1 + 200*0.5 = 150
    // imb = (205-150)/(205+150) = 55/355 ≈ 0.1549
    const result = multiLevelImbalance(bids, asks, 2);
    expect(result).toBeCloseTo(55 / 355, 10);
  });
});
