import { describe, it, expect } from 'vitest';
import { trafficLight, expectedQty, wastagePct, approvalBlockers } from '../server/domain.js';

describe('domain rules', () => {
  it('multiplier engine: 50 garments x 2 cuffs = 100', () => expect(expectedQty(50, 2)).toBe(100));
  it('traffic light: GREEN / YELLOW / RED / uncounted', () => {
    expect(trafficLight(100, 100)).toBe('GREEN');
    expect(trafficLight(100, 103)).toBe('YELLOW');
    expect(trafficLight(100, 99)).toBe('RED');
    expect(trafficLight(100, 0)).toBe('RED');
    expect(trafficLight(100, null)).toBeNull();
  });
  it('wastage % = (actual - expected) / expected x 100', () => {
    // 50 blouses x 1.8 = 90 yds expected; 94.5 used => 5.00%
    expect(wastagePct(94.5, 50, 1.8)).toBe(5);
    expect(wastagePct(90, 50, 1.8)).toBe(0);
    expect(wastagePct(85.5, 50, 1.8)).toBe(-5);
  });
  it('approval blockers flag RED and uncounted but allow YELLOW', () => {
    const base = { component_id: 1, component_name: 'x', expected_qty: 10 };
    expect(approvalBlockers([{ ...base, actual_qty: 12 }])).toEqual([]);
    expect(approvalBlockers([{ ...base, actual_qty: 9 }])[0].reason).toBe('SHORTAGE');
    expect(approvalBlockers([{ ...base, actual_qty: null }])[0].reason).toBe('UNCOUNTED');
    expect(approvalBlockers([])[0].reason).toBe('NO_COMPONENTS');
  });
});
