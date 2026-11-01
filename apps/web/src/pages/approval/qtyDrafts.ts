/**
 * DX-APR-2 (2026-11-01): the reviewer's +/− taps add up locally and only
 * the final value is sent, once the taps stop. Before, every tap was a
 * server write, the whole list was disabled until it came back, and taps
 * made meanwhile landed on disabled buttons and were lost (3 taps → +1).
 *
 * Framework-free so it can be tested: the component keeps one per card
 * and renders `value(key) ?? serverQty`.
 */
export const QTY_DRAFT_QUIET_MS = 350;

export class QtyDrafts {
  private drafts = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private saving = new Set<string>();

  constructor(
    private readonly send: (key: string, value: number) => Promise<unknown>,
    private readonly onChange: () => void,
    private readonly quietMs = QTY_DRAFT_QUIET_MS,
  ) {}

  /** The value on screen for a row while it differs from the server. */
  value(key: string): number | undefined {
    return this.drafts.get(key);
  }

  /** The row is being written; only that row is locked. */
  isSaving(key: string): boolean {
    return this.saving.has(key);
  }

  /** Taps not yet sent, or a write not yet answered (holds 「通过」). */
  get busy(): boolean {
    return this.timers.size > 0 || this.saving.size > 0;
  }

  set(key: string, value: number): void {
    this.drafts.set(key, value);
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    this.timers.set(
      key,
      setTimeout(() => void this.flush(key), this.quietMs),
    );
    this.onChange();
  }

  /** Send the row's last value now. */
  async flush(key: string): Promise<void> {
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    this.timers.delete(key);
    const value = this.drafts.get(key);
    if (value === undefined) return;
    this.saving.add(key);
    this.onChange();
    try {
      await this.send(key, value);
    } finally {
      this.saving.delete(key);
      // A newer tap made while this was saving keeps its own draft.
      if (!this.timers.has(key) && this.drafts.get(key) === value) this.drafts.delete(key);
      this.onChange();
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
