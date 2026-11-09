import { describe, expect, it } from 'bun:test';
import { closedFor } from '../draftClose';

describe('closedFor (RUNWEB1-01 / -02)', () => {
  const sent = { runId: 'r1', skuId: 'beef' };

  it('closes the form the answer is for', () => {
    expect(closedFor({ runId: 'r1', skuId: 'beef', note: 'x' }, sent)).toBeNull();
  });

  it("leaves another product's form open, as typed", () => {
    const other = { runId: 'r1', skuId: 'milk', note: 'half typed' };
    expect(closedFor(other, sent)).toBe(other);
  });

  it('leaves a form for another run, an expense form and no form alone', () => {
    const otherRun = { runId: 'r2', skuId: 'beef' };
    expect(closedFor(otherRun, sent)).toBe(otherRun);
    const expense = { runId: 'r1', skuId: null };
    expect(closedFor(expense, sent)).toBe(expense);
    expect(closedFor(null, sent)).toBeNull();
  });
});
