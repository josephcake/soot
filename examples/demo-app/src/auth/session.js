/** A session token is expired once `now` reaches its expiry (the old bug used `>`). */
export function isExpired(token, now) {
  return now >= token.expiresAt;
}
