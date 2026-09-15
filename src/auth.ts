/**
 * Pluggable credential verification.
 *
 * The login endpoint (src/api/server.ts) verifies a username/password pair
 * through `getCredentialVerifier().verify(...)`. The default implementation is
 * file-based (see settings.ts#fileVerifyCredentials), but the abstraction lets
 * us later swap in an external identity provider (LDAP, an existing user DB,
 * OIDC, ...) without touching the API endpoint: implement CredentialVerifier and
 * call setCredentialVerifier(...) (or select by env).
 */
import { fileVerifyCredentials } from "./settings.js";

export interface CredentialVerifier {
  /** Return the userId on success, or null if the credentials are invalid. */
  verify(username: string, password: string): Promise<string | null>;
}

/** Default file-based verifier (reads ~/.config/qmd/users/<id>.json). */
export const fileBasedVerifier: CredentialVerifier = {
  verify: (username, password) => Promise.resolve(fileVerifyCredentials(username, password)),
};

let activeVerifier: CredentialVerifier = fileBasedVerifier;

/** Swap the active verifier (e.g. to integrate an external identity provider). */
export function setCredentialVerifier(v: CredentialVerifier): void {
  activeVerifier = v;
}

/** Get the currently active credential verifier. */
export function getCredentialVerifier(): CredentialVerifier {
  return activeVerifier;
}
