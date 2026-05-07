/**
 * Domain-level errors. The transport layer (tRPC) translates these to its
 * own error codes. We never throw raw English strings — every error carries
 * an i18n key so the client can render the user's language.
 */
export type DomainErrorCode =
  | 'VALIDATION'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly i18nKey: string;
  public readonly context: Record<string, unknown>;
  public readonly retriable: boolean;

  constructor(
    code: DomainErrorCode,
    i18nKey: string,
    opts: { message?: string; context?: Record<string, unknown>; retriable?: boolean } = {},
  ) {
    super(opts.message ?? i18nKey);
    this.name = 'DomainError';
    this.code = code;
    this.i18nKey = i18nKey;
    this.context = opts.context ?? {};
    this.retriable = opts.retriable ?? false;
  }
}

export const validation = (key: string, ctx?: Record<string, unknown>): DomainError =>
  new DomainError('VALIDATION', key, { context: ctx });

export const forbidden = (key: string, ctx?: Record<string, unknown>): DomainError =>
  new DomainError('FORBIDDEN', key, { context: ctx });

export const conflict = (key: string, ctx?: Record<string, unknown>): DomainError =>
  new DomainError('CONFLICT', key, { context: ctx, retriable: true });

export const preconditionFailed = (key: string, ctx?: Record<string, unknown>): DomainError =>
  new DomainError('PRECONDITION_FAILED', key, { context: ctx });

export const notFound = (key: string, ctx?: Record<string, unknown>): DomainError =>
  new DomainError('NOT_FOUND', key, { context: ctx });
