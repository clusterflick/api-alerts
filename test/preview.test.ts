import type { Movie } from "@clusterflick/catalogue/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, film, NOW } from "./fixtures";
import {
  ALERTS,
  reader,
  request,
  resetWorker,
  runNight,
  serve,
  signIn,
  SITE,
} from "./helpers";

beforeEach(() => {
  resetWorker();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Preview = {
  mode: string;
  baseline: boolean;
  lastRun: string | null;
  digest: { subject: string; html: string; text: string; films: number } | null;
};

async function preview(
  body: unknown,
  { uid = "u1", token }: { uid?: string; token?: string | null } = {},
) {
  const auth = token === null ? undefined : (token ?? (await signIn(uid)));
  const response = await request(`${ALERTS}/preview`, {
    method: "POST",
    headers: {
      Origin: SITE,
      "Content-Type": "application/json",
      ...(auth && { Authorization: `Bearer ${auth}` }),
    },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: response.ok ? ((await response.json()) as Preview) : null,
  };
}

const HALLOWEEN = film("m1", "Halloween", { rio: [at(1, 19)] });

describe("everything showing", () => {
  it("is the email with every watchlist film on now", async () => {
    serve({
      movies: () => [HALLOWEEN],
      store: reader("u1", { m1: "Halloween", m2: "Not On" }),
    });
    const { response, body } = await preview({
      mode: "everythingShowing",
      notify: ["firstListing"],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(body?.digest).toMatchObject({
      subject: "Halloween: Now showing",
      films: 1,
    });
    // Nothing unsubscribes from a preview.
    expect(body?.digest?.text).not.toContain("Unsubscribe");
  });
});

describe("since the last run", () => {
  it("says there's nothing to compare with before the first run", async () => {
    serve({
      movies: () => [HALLOWEEN],
      store: reader("u1", { m1: "Halloween" }),
    });
    const { body } = await preview({
      mode: "sinceLastRun",
      notify: ["firstListing", "newVenue"],
    });
    expect(body).toMatchObject({ baseline: true, lastRun: null, digest: null });
  });

  it("is tonight's email so far, against the last run, with the triggers being edited", async () => {
    let movies: Movie[] = [HALLOWEEN];
    const store = reader("u1", { m1: "Halloween" });
    serve({ movies: () => movies, store });
    await runNight(NOW - 60_000);
    movies = [film("m1", "Halloween", { rio: [at(1, 19)], pcc: [at(2, 20)] })];

    const on = await preview({ mode: "sinceLastRun", notify: ["newVenue"] });
    expect(on.body).toMatchObject({ baseline: false });
    expect(on.body?.digest?.subject).toBe(
      "Halloween: Now also at Prince Charles Cinema",
    );
    const off = await preview({
      mode: "sinceLastRun",
      notify: ["firstListing"],
    });
    expect(off.body?.digest).toBeNull();
    // Never written: the preview only looks.
    expect(
      (store["users/u1/meta/alert-ledger"] as { films: { m1: unknown } }).films
        .m1,
    ).toMatchObject({ venues: ["rio"] });
  });
});

describe("a preview", () => {
  it("needs a sign-in", async () => {
    serve({ movies: () => [], store: reader("u1", {}) });
    const { response } = await preview(
      { mode: "everythingShowing" },
      { token: null },
    );
    expect(response.status).toBe(401);
  });

  it("needs the capability", async () => {
    const store = reader("u1", {});
    delete store["users/u1/meta/capabilities"];
    serve({ movies: () => [], store });
    const { response } = await preview({ mode: "everythingShowing" });
    expect(response.status).toBe(403);
  });

  it("needs a mode it knows", async () => {
    serve({ movies: () => [], store: reader("u1", {}) });
    const { response } = await preview({ mode: "everything" });
    expect(response.status).toBe(400);
  });

  it("says it's unavailable when the listings can't be read", async () => {
    serve({ movies: () => [], store: reader("u1", {}), siteStatus: 503 });
    const { response } = await preview({ mode: "everythingShowing" });
    expect(response.status).toBe(503);
  });

  it("answers the site's pages, and no other site's", async () => {
    serve({ movies: () => [], store: reader("u1", {}) });
    const preflight = (origin: string) =>
      request(`${ALERTS}/preview`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
    expect(
      (await preflight(SITE)).headers.get("Access-Control-Allow-Origin"),
    ).toBe(SITE);
    expect(
      (await preflight("https://evil.example")).headers.get(
        "Access-Control-Allow-Origin",
      ),
    ).toBeNull();
  });
});

it("anything else isn't found", async () => {
  serve({ movies: () => [], store: {} });
  expect((await request(`${ALERTS}/`)).status).toBe(404);
});
