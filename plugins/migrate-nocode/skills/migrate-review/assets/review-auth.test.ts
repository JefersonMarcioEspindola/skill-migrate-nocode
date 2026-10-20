// Tests for review-auth.ts (vitest). Copy next to lib/review-auth.ts.
import { describe, expect, it } from "vitest";

import { REVIEW_PATH, checkBasicAuth, parseBasicAuth, reviewGuard } from "./review-auth";

const enc = (s: string) => Buffer.from(s, "utf8").toString("base64");
const req = (auth?: string) => new Request("https://example.com/review", auth ? { headers: { authorization: auth } } : undefined);

describe("parseBasicAuth", () => {
  it("reads user and password", () => expect(parseBasicAuth(`Basic ${enc("ana:secret")}`)).toEqual({ user: "ana", password: "secret" }));
  it("accepts the scheme in any case", () => expect(parseBasicAuth(`basic ${enc("a:b")}`)?.password).toBe("b"));
  it("keeps colons inside the password", () => expect(parseBasicAuth(`Basic ${enc("a:b:c")}`)?.password).toBe("b:c"));
  it("decodes UTF-8", () => expect(parseBasicAuth(`Basic ${enc("a:ção")}`)?.password).toBe("ção"));
  it("invalid base64 returns null (never throws)", () => {
    expect(parseBasicAuth("Basic !!!")).toBeNull();
    expect(parseBasicAuth("Basic YWJj=x")).toBeNull();
  });
  it("invalid UTF-8 returns null", () => expect(parseBasicAuth(`Basic ${Buffer.from([0x61, 0x3a, 0xff, 0xfe]).toString("base64")}`)).toBeNull());
  it("no header, other scheme or no colon returns null", () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth(`Bearer ${enc("a:b")}`)).toBeNull();
    expect(parseBasicAuth(`Basic ${enc("nocolon")}`)).toBeNull();
  });
});

describe("checkBasicAuth", () => {
  it("right password passes, wrong one does not", async () => {
    expect(await checkBasicAuth(`Basic ${enc("x:ção")}`, "ção")).toBe(true);
    expect(await checkBasicAuth(`Basic ${enc("x:cao")}`, "ção")).toBe(false);
  });
  it("invalid header does not pass", async () => expect(await checkBasicAuth("Basic !!!", "x")).toBe(false));
  it("an empty configured password never passes", async () => expect(await checkBasicAuth(`Basic ${enc("x:")}`, "")).toBe(false));
});

describe("REVIEW_PATH", () => {
  it("matches the page and its assets only", () => {
    for (const p of ["/review", "/review/", "/review-assets/index/1440/live.webp"]) expect(REVIEW_PATH.test(p)).toBe(true);
    for (const p of ["/reviews", "/review-x", "/blog/review"]) expect(REVIEW_PATH.test(p)).toBe(false);
  });
});

describe("reviewGuard", () => {
  it("without a password: passes with noindex", async () => {
    const res = await reviewGuard(req(), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });
  it("with a password: 401 + challenge without or with a wrong header", async () => {
    for (const auth of [undefined, "Basic !!!", `Basic ${enc("u:wrong")}`]) {
      const res = await reviewGuard(req(auth), "pw");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Basic");
      expect(res.headers.get("x-robots-tag")).toContain("noindex");
    }
  });
  it("with a password: the right one passes", async () => expect((await reviewGuard(req(`Basic ${enc("u:pw")}`), "pw")).status).toBe(200));
});
