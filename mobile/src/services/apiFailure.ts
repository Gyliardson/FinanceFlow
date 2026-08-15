type ErrorWithResponse = {
  response?: {
    status?: unknown;
  };
};

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
 * authoritatively and must not be replaced by stale local data. The explicit
 * transient statuses below remain eligible for conservative read-only fallback.
 */
export const canUseOfflineCacheForApiFailure = (error: unknown): boolean => {
  const status = apiFailureStatus(error);
  if (status === null) return true;
  if (status >= 500) return true;
  return status === 408 || status === 425 || status === 429;
};
