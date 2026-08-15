import { StaleAuthSessionError } from './apiFailure';

export interface AuthenticatedResponseSnapshot {
  accessToken: string;
  userId: string;
  generation: number;
}

export type AuthenticatedResponseSnapshotValidator = (
  snapshot: AuthenticatedResponseSnapshot,
) => Promise<boolean> | boolean;

/**
 * A successful HTTP response is only consumable while the exact authenticated
 * session snapshot that authorized the request is still current. This prevents
 * late reads from a logged-out/replaced session from repopulating owner-scoped
 * caches after local teardown.
 */
export async function assertCurrentAuthenticatedResponse(
  snapshot: AuthenticatedResponseSnapshot | undefined,
  validator: AuthenticatedResponseSnapshotValidator | null,
): Promise<void> {
  if (!snapshot || !validator) return;
  if (!(await validator(snapshot))) {
    throw new StaleAuthSessionError();
  }
}
