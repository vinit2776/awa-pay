import { createHmac, timingSafeEqual } from "node:crypto";
import { SESSION_SECRET } from "./env";

// Zero DB imports — only node:crypto + env.ts — deliberately, so
// src/proxy.ts can check a cookie without pulling postgres/drizzle into
// the proxy bundle. Cookie value is base64url(rawToken) + "." +
// HMAC-SHA256(rawToken, SESSION_SECRET), base64url-encoded. Not a JWT: no
// claims, no expiry encoded in the signature — meaningless without the
// session table row keyed by SHA-256(rawToken). This only lets a caller
// cheaply reject a tampered/garbage cookie with no DB round trip; the
// database remains the sole source of truth for revocation and expiry.
function sign(rawToken: string): string {
  return createHmac("sha256", SESSION_SECRET).update(rawToken).digest("base64url");
}

export function signToken(rawToken: string): string {
  return `${Buffer.from(rawToken, "utf8").toString("base64url")}.${sign(rawToken)}`;
}

export function verifyAndExtractToken(cookieValue: string): string | null {
  const dotIndex = cookieValue.indexOf(".");
  if (dotIndex === -1) return null;

  const encodedToken = cookieValue.slice(0, dotIndex);
  const signature = cookieValue.slice(dotIndex + 1);

  let rawToken: string;
  try {
    rawToken = Buffer.from(encodedToken, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expected = sign(rawToken);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }

  return rawToken;
}
