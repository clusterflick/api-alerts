import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unsubscribeUrl } from "../src/unsubscribe";
import { NOW } from "./fixtures";
import {
  ALERTS,
  logged,
  reader,
  request,
  resetWorker,
  serve,
  type Store,
} from "./helpers";

let log: ReturnType<typeof resetWorker>["log"];

beforeEach(() => {
  ({ log } = resetWorker());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const link = (uid = "u1", emailOn = "2026-11-15") =>
  unsubscribeUrl(env, ALERTS, uid, emailOn);

/** As a mail client's one-click sends it (RFC 8058). */
const oneClick = async (url: string) =>
  request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });

const settings = (store: Store) =>
  store["users/u1/meta/alerts"] as { enabled: boolean };
const ledger = (store: Store) =>
  store["users/u1/meta/alert-ledger"] as { stopped?: unknown } | undefined;

describe("one-click unsubscribe", () => {
  it("switches alerts off, and records when and from which email", async () => {
    const store = reader("u1", { m1: "Halloween" });
    serve({ movies: () => [], store });
    const response = await oneClick(await link());
    expect(response.status).toBe(200);
    expect(settings(store).enabled).toBe(false);
    expect(ledger(store)?.stopped).toEqual({
      reason: "unsubscribed",
      at: NOW,
      emailOn: "2026-11-15",
    });
    // The rest of the settings are theirs, and kept.
    expect(store["users/u1/meta/alerts"]).toMatchObject({
      email: "u1@example.com",
      alerts: [{ type: "watchlist" }],
    });
    expect(logged(log, "alerts-unsubscribed")).toEqual([
      { event: "alerts-unsubscribed", uid: "u1", emailOn: "2026-11-15" },
    ]);
  });

  it("does nothing for an account that's gone", async () => {
    const store: Store = {};
    serve({ movies: () => [], store });
    expect((await oneClick(await link())).status).toBe(200);
    expect(store).toEqual({});
  });
});

describe("the footer link", () => {
  it("asks first, and changes nothing, since mail scanners follow links", async () => {
    const store = reader("u1", { m1: "Halloween" });
    serve({ movies: () => [], store });
    const response = await request(await link());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Unsubscribe from alerts?");
    expect(html).toContain('<form method="post"');
    expect(settings(store).enabled).toBe(true);
  });
});

describe("a link that isn't ours", () => {
  it.each([
    ["no token", `${ALERTS}/unsubscribe`],
    ["a cut-off token", `${ALERTS}/unsubscribe?t=u1.2026-11-15`],
  ])("is refused: %s", async (_, url) => {
    const store = reader("u1", {});
    serve({ movies: () => [], store });
    expect((await oneClick(url)).status).toBe(400);
    expect(settings(store).enabled).toBe(true);
  });

  it("is refused when signed for someone else", async () => {
    const store = reader("u1", {});
    serve({ movies: () => [], store });
    const theirs = new URL(await link("u2"));
    const token = theirs.searchParams.get("t")!.replace(/^u2\./, "u1.");
    expect(
      (await oneClick(`${ALERTS}/unsubscribe?t=${encodeURIComponent(token)}`))
        .status,
    ).toBe(400);
    expect(settings(store).enabled).toBe(true);
  });
});
