/** OAuth error answered as RFC 6749 `{ error, error_description }` with HTTP 400. */
export class OAuthError extends Error {
  constructor(readonly code: string, description: string) {
    super(description);
  }

  toResponseObject() {
    return { error: this.code, error_description: this.message };
  }
}
