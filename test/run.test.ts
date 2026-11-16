import type { Movie } from "@clusterflick/catalogue/types";
import { addLondonDays } from "@clusterflick/catalogue/utils/format-date";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASONS } from "../src/run";
import { at, dayFrom, film, NOW, TODAY } from "./fixtures";
import {
  logged,
  reader,
  resetWorker,
  runNight,
  runScheduled,
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

/** 20:00 the next day. */
const NEXT_NIGHT = NOW + (addLondonDays(NOW, 1) - addLondonDays(NOW, 0));

const ledger = (store: Store, uid = "u1") =>
  store[`users/${uid}/meta/alert-ledger`] as {
    runs: Record<string, unknown>[];
    films: Record<string, unknown>;
  };

describe("the first night", () => {
  it("remembers the watchlist as it stands, and has nothing new", async () => {
    const store = reader("u1", { m1: "Halloween" });
    serve({ movies: () => [], store });
    const night = await runNight(NOW);
    expect(night).toMatchObject({
      on: TODAY,
      readers: 1,
      nothingNew: 1,
      dryRun: true,
    });
    // Said to be the first check, so it isn't taken for a quiet night.
    expect(ledger(store).runs).toEqual([
      {
        on: TODAY,
        at: NOW,
        outcome: "nothingNew",
        reason: REASONS.firstCheck,
      },
    ]);
    expect(ledger(store).films).toEqual({
      m1: { showing: false, venues: [] },
    });
    expect(store[`alertRuns/${TODAY}`]).toMatchObject({ readers: 1 });
  });
});

describe("the next night", () => {
  it("works out the email, and while trying alerts out, records it unsent", async () => {
    const store = reader("u1", { m1: "Halloween" });
    let movies: Movie[] = [];
    const { spy } = serve({ movies: () => movies, store });
    await runNight(NOW);

    vi.setSystemTime(NEXT_NIGHT);
    movies = [film("m1", "Halloween", { rio: [at(2, 19)] })];
    const night = await runNight(NEXT_NIGHT);
    expect(night).toMatchObject({ previewed: 1 });
    expect(ledger(store).runs[0]).toEqual({
      on: dayFrom(1),
      at: NEXT_NIGHT,
      outcome: "previewed",
      films: 1,
    });
    expect(ledger(store).films.m1).toMatchObject({
      showing: true,
      venues: ["rio"],
    });
    // Nothing anywhere but the site, Google and Firestore.
    for (const [input] of spy.mock.calls) {
      expect(new URL(String(input)).hostname).toMatch(
        /^(clusterflick\.com|oauth2\.googleapis\.com|firestore\.googleapis\.com)$/,
      );
    }
  });

  it("tells of a film added today and listed before the run", async () => {
    const store = reader("u1", { m1: "Halloween" });
    let movies: Movie[] = [];
    serve({ movies: () => movies, store });
    await runNight(NOW);

    // Added the next morning, while not showing; listed that afternoon.
    const users = store["users/u1"] as {
      watchlist: Record<string, { title: string; addedAt: number }>;
    };
    users.watchlist.m2 = {
      title: "Cléo from 5 to 7",
      addedAt: NOW + 14 * 3_600_000,
    };
    movies = [
      film(
        "m2",
        "Cléo from 5 to 7",
        { bfi: [at(2, 14)] },
        {},
        {
          bfi: NOW + 20 * 3_600_000,
        },
      ),
    ];
    vi.setSystemTime(NEXT_NIGHT);
    expect(await runNight(NEXT_NIGHT)).toMatchObject({ previewed: 1 });
  });

  it("with nothing new is a quiet night, not a first check", async () => {
    const store = reader("u1", { m1: "Halloween" });
    serve({ movies: () => [], store });
    await runNight(NOW);
    vi.setSystemTime(NEXT_NIGHT);
    await runNight(NEXT_NIGHT);
    expect(ledger(store).runs[0]).toEqual({
      on: dayFrom(1),
      at: NEXT_NIGHT,
      outcome: "nothingNew",
    });
  });

  it("isn't run twice in one night", async () => {
    const store = reader("u1", { m1: "Halloween" });
    const { writes } = serve({ movies: () => [], store });
    await runNight(NOW);
    const ledgerWrites = () =>
      writes.filter((path) => path.endsWith("alert-ledger")).length;
    expect(ledgerWrites()).toBe(1);
    const again = await runNight(NOW + 60_000);
    expect(again).toMatchObject({ alreadyRun: 1 });
    expect(ledgerWrites()).toBe(1);
  });
});

describe("a reader who can't be sent anything", () => {
  it("whose capability was revoked is skipped, and told why", async () => {
    const store = reader("u1", { m1: "Halloween" });
    delete store["users/u1/meta/capabilities"];
    serve({ movies: () => [], store });
    expect(await runNight(NOW)).toMatchObject({ skipped: 1 });
    expect(ledger(store).runs[0]).toMatchObject({
      outcome: "skipped",
      reason: REASONS.notGranted,
    });
  });

  it("with no address fails, loudly, and is told to save again", async () => {
    const store = reader("u1", { m1: "Halloween" }, { email: null });
    serve({ movies: () => [], store });
    await expect(runNight(NOW)).rejects.toThrow("had failures");
    expect(ledger(store).runs[0]).toMatchObject({
      outcome: "failed",
      reason: REASONS.noAddress,
    });
    expect(store[`alertRuns/${TODAY}`]).toMatchObject({ failed: 1 });
  });

  it("with alerts off isn't looked at", async () => {
    const store = reader("u1", { m1: "Halloween" }, { enabled: false });
    serve({ movies: () => [], store });
    expect(await runNight(NOW)).toMatchObject({ readers: 0 });
    expect(store["users/u1/meta/alert-ledger"]).toBeUndefined();
  });
});

describe("a night the listings can't be read", () => {
  it("fails every reader's run, loudly, rather than finding nothing new", async () => {
    const store = {
      ...reader("u1", { m1: "Halloween" }),
      ...reader("u2", { m2: "Cléo from 5 to 7" }),
    };
    serve({ movies: () => [], store, siteStatus: 503 });
    await expect(runNight(NOW)).rejects.toThrow("had failures");
    for (const uid of ["u1", "u2"]) {
      expect(ledger(store, uid).runs[0]).toMatchObject({
        outcome: "failed",
        reason: REASONS.noListings,
      });
    }
    expect(store[`alertRuns/${TODAY}`]).toMatchObject({
      release: null,
      failed: 2,
    });
  });

  it("keeps what the ledger remembers, so tomorrow's news isn't lost", async () => {
    const store = reader("u1", { m1: "Halloween" });
    let siteStatus: number | undefined;
    serve({
      movies: () => [],
      store,
      get siteStatus() {
        return siteStatus;
      },
    });
    await runNight(NOW);
    const remembered = ledger(store).films;
    vi.setSystemTime(NEXT_NIGHT);
    siteStatus = 503;
    await expect(runNight(NEXT_NIGHT)).rejects.toThrow();
    expect(ledger(store).films).toEqual(remembered);
  });
});

it("logs each reader's outcome and the night's, never their watchlist", async () => {
  const store = reader("u1", { m1: "Halloween" });
  serve({ movies: () => [], store });
  await runNight(NOW);
  expect(logged(log, "alerts-reader")).toEqual([
    { event: "alerts-reader", uid: "u1", outcome: "nothingNew" },
  ]);
  expect(logged(log, "alerts-night")).toHaveLength(1);
  expect(JSON.stringify(log.mock.calls)).not.toContain("Halloween");
});

it("is what the cron runs", async () => {
  const store = reader("u1", { m1: "Halloween" });
  serve({ movies: () => [], store });
  await runScheduled(NOW);
  expect(ledger(store).runs).toHaveLength(1);
});
