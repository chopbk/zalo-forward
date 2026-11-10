import { describe, expect, it } from 'vitest';
import { SendQueue } from '../src/relay/queue.js';

describe('SendQueue', () => {
  it('runs jobs sequentially with min interval', async () => {
    const q = new SendQueue(50, 0);
    const times: number[] = [];
    await Promise.all([
      q.enqueue(async () => {
        times.push(Date.now());
        return 1;
      }),
      q.enqueue(async () => {
        times.push(Date.now());
        return 2;
      }),
    ]);
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(45);
  });
});
