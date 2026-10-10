/**
 * Reading a response from the Bot API relay (infra/cloudflare/tg-relay.js).
 *
 * Two parties can say no. The Bot API answers in JSON (`{ ok: false,
 * error_code, description }`) and its 400 / 403 are about the recipient:
 * the user blocked the bot, the chat id is wrong. Retrying cannot help.
 * The relay itself answers in plain text (`forbidden` for a bad shared
 * key, `invalid json`, `method not allowed`) and those are about OUR
 * configuration: every message will fail the same way until someone
 * fixes it, so they must stay queued.
 */
export class RelayError extends Error {
  constructor(
    public errorCode: number,
    public description: string,
    /** True only when the Bot API itself produced the verdict. */
    public fromBotApi: boolean,
  ) {
    super(`relay ${errorCode}: ${description}`);
  }

  /** Safe to mark the outbox row sent: no retry will ever deliver it. */
  get permanent(): boolean {
    return this.fromBotApi && (this.errorCode === 403 || this.errorCode === 400);
  }
}

/** Throws RelayError unless the Bot API accepted the call. */
export function assertRelayDelivered(status: number, rawBody: string): void {
  type BotApiBody = { ok?: boolean; error_code?: number; description?: string };
  let body: BotApiBody | null = null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') body = parsed as BotApiBody;
  } catch {
    // Not JSON: the relay or the edge in front of it answered.
  }
  if (body?.ok === true && status >= 200 && status < 300) return;
  if (body?.ok === false) {
    throw new RelayError(
      body.error_code ?? status,
      body.description ?? 'unknown bot api error',
      true,
    );
  }
  throw new RelayError(status, body?.description ?? `relay answered http ${status}`, false);
}
