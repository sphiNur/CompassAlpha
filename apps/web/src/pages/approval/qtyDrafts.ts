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
  private inflight = new Set<Promise<unknown>>();

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
    const sent = this.send(key, value);
    this.inflight.add(sent);
    try {
      await sent;
    } finally {
      this.inflight.delete(sent);
      this.saving.delete(key);
      // A newer tap made while this was saving keeps its own draft.
      if (!this.timers.has(key) && this.drafts.get(key) === value) this.drafts.delete(key);
      this.onChange();
    }
  }

  /** Send every row still waiting (the page is going away). */
  flushAll(): Promise<void> {
    return Promise.allSettled([...this.timers.keys()].map((key) => this.flush(key))).then(
      () => undefined,
    );
  }

  /**
   * The card is going away: collapsed, another tab, the app closing.
   *
   * Review ORD-02 (2026-11-09): this used to cancel the timers, so a tap
   * made just before collapsing was never sent, and 「通过」 unlocked on
   * the old number. The taps still waiting are sent now; the promise
   * settles once they and any write already in flight are answered, so
   * the caller can keep 「通过」 held until then.
   */
  dispose(): Promise<void> {
    const waiting = [...this.timers.keys()].map((key) => this.flush(key));
    return Promise.allSettled([...waiting, ...this.inflight]).then(() => undefined);
  }
}
