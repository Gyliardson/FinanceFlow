type ErrorWithResponse = {
  response?: {
    status?: unknown;
  };
};

export const STALE_AUTH_SESSION_ERROR_CODE = 'FINANCEFLOW_STALE_AUTH_SESSION';

export class StaleAuthSessionError extends Error {
  readonly code = STALE_AUTH_SESSION_ERROR_CODE;

  constructor() {
    super('Authenticated session changed before the response could be consumed.');
    this.name = 'StaleAuthSessionError';
  }
}

type ErrorWithCode = {
  code?: unknown;
};

export const isStaleAuthSessionFailure = (error: unknown): boolean =>
  Boolean(
    error
      && typeof error === 'object'
      && (error as ErrorWithCode).code === STALE_AUTH_SESSION_ERROR_CODE
  );

export const apiFailureStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') return null;
  const status = Number((error as ErrorWithResponse).response?.status ?? 0);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
};

export const isAuthenticationRejected = (error: unknown): boolean =>
  apiFailureStatus(error) === 401;

export const isAuthorizationRejected = (error: unknown): boolean =>
  apiFailureStatus(error) === 403;

/**
 * Offline cache is a transport/service resilience mechanism, not an HTTP error
 * masking mechanism. A response-level 4xx normally means the server did answer
 * authoritatively and must not be replaced by stale local data. A response that
 * belongs to an obsolete authenticated session is also authoritative-but-stale:
 * it must never be converted into an offline-cache read during account teardown
 * or replacement. The explicit transient statuses below remain eligible for
 * conservative read-only fallback.
 */
export const canUseOfflineCacheForApiFailure = (error: unknown): boolean => {
  if (isStaleAuthSessionFailure(error)) return false;
  const status = apiFailureStatus(error);
  if (status === null) return true;
  if (status >= 500) return true;
  return status === 408 || status === 425 || status === 429;
};
