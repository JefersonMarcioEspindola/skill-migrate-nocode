// Optional password for /review and /review-assets (RFC 7617 Basic Auth, any user name, password = REVIEW_PASSWORD).
// Runs in the Next.js proxy/middleware runtime (Web APIs only: atob, TextDecoder, crypto.subtle). Always adds
// X-Robots-Tag. Without REVIEW_PASSWORD the page stays open (but out of the index).
//
// Install: copy to lib/review-auth.ts and call it first in proxy.ts (Next 16) or middleware.ts (Next ≤ 15):
//
//   import { REVIEW_PATH, reviewGuard } from "@/lib/review-auth";
//   export async function proxy(request: NextRequest) {            // or: export async function middleware(...)
//     if (REVIEW_PATH.test(request.nextUrl.pathname)) return reviewGuard(request);
//     ...the rest of your proxy...
//   }
//   export const config = { matcher: ["/review", "/review-assets/:path*", ...yourOtherMatchers] };
//
// With no proxy/middleware yet, a minimal one is just the two lines above plus `return NextResponse.next()`.
import { NextResponse } from "next/server";

/** /review, /review/..., /review-assets/... (not /reviews or /review-x). */
export const REVIEW_PATH = /^\/review(?:-assets)?(?:\/|$)/;

const ROBOTS = "noindex, nofollow, noarchive, noimageindex";

/** Reads "Basic <base64(user:password)>". Case-insensitive scheme, UTF-8. Invalid header → null (never throws). */
export function parseBasicAuth(header: string | null | undefined): { user: string; password: string } | null {
  if (!header) return null;
  const [scheme, encoded] = header.trim().split(/\s+/, 2);
  if (!scheme || scheme.toLowerCase() !== "basic" || !encoded) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  let decoded: string;
  try {
    const bin = atob(encoded);
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** True when the header carries the expected password (any user). Compares SHA-256 digests in constant time. */
export async function checkBasicAuth(header: string | null | undefined, expected: string | undefined): Promise<boolean> {
  const creds = parseBasicAuth(header);
  if (!creds || !expected) return false;
  const [a, b] = await Promise.all([digest(creds.password), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 401 with a Basic challenge when REVIEW_PASSWORD is set and the request lacks it; otherwise continue with noindex. */
export async function reviewGuard(request: Request, password: string | undefined = process.env.REVIEW_PASSWORD): Promise<Response> {
  if (password && !(await checkBasicAuth(request.headers.get("authorization"), password))) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="review", charset="UTF-8"',
        "X-Robots-Tag": ROBOTS,
        "Cache-Control": "no-store",
      },
    });
  }
  const res = NextResponse.next();
  res.headers.set("X-Robots-Tag", ROBOTS);
  if (password) res.headers.set("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
  return res;
}
