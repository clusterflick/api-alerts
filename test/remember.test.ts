import type { Movie } from "@clusterflick/catalogue/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, film, NOW, TODAY } from "./fixtures";
import {
  ALERTS,
  logged,
  reader,
  request,
  resetWorker,
  runNight,
  serve,
  signIn,
  SITE,
  type Store,
} from "./helpers";

let log: ReturnType<typeof resetWorker>["log"];

/** An hour before tonight's run. */
const SWITCHED_ON = NOW - 3_600_000;

beforeEach(() => {
  ({ log } = resetWorker());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SWITCHED_ON);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function remember(uid = "u1", token?: string | null) {
  const auth = token === null ? undefined : (token ?? (await signIn(uid)));
  return request(`${ALERTS}/remember`, {
    method: "POST",
    headers: {
      Origin: SITE,
      ...(auth && { Authorization: `Bearer ${auth}` }),
    },
  });
}

const ledger = (store: Store) =>
  store["users/u1/meta/alert-ledger"] as {
    runs?: unknown[];
    films: Record<string, { showing: boolean; venues: string[] }>;
    rememberedAt?: number;
  };

describe("switching alerts on", () => {
  it("remembers the watchlist as it stands, without recording a run", async () => {
    const store = reader("u1", { m1: "Halloween", m2: "Cléo from 5 to 7" });
    serve({
      movies: () => [film("m1", "Halloween", { rio: [at(1, 19)] })],
      store,
    });
    const response = await remember();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ films: 2 });
    expect(ledger(store).films).toEqual({
      m1: { showing: true, lastShowing: TODAY, venues: ["rio"] },
      m2: { showing: false, venues: [] },
    });
    expect(ledger(store).rememberedAt).toBe(SWITCHED_ON);
    expect(ledger(store).runs).toBeUndefined();
  });

  it("makes that night's run find what's new since, rather than only remembering", async () => {
    const store = reader("u1", { m1: "Halloween", m2: "Cléo from 5 to 7" });
    let movies: Movie[] = [film("m1", "Halloween", { rio: [at(1, 19)] })];
    serve({ movies: () => movies, store });
    await remember();

    vi.setSystemTime(NOW);
    movies = [
      film("m1", "Halloween", { rio: [at(1, 19)], pcc: [at(2, 20)] }),
      film("m2", "Cléo from 5 to 7", { bfi: [at(1, 14)] }),
    ];
    const night = await runNight(NOW);
    expect(night).toMatchObject({ previewed: 1 });
    expect(ledger(store).runs?.[0]).toMatchObject({
      on: TODAY,
      outcome: "previewed",
      films: 2,
    });
  });

  it("starts again each time, so news is from the latest switch-on", async () => {
    const store = {
      ...reader("u1", { m1: "Halloween" }),
      "users/u1/meta/alert-ledger": {
        runs: [{ on: "2026-10-01", at: 1, outcome: "nothingNew" }],
        films: { m1: { showing: false, venues: ["ica"] } },
      },
    };
    serve({
      movies: () => [film("m1", "Halloween", { rio: [at(1, 19)] })],
      store,
    });
    expect((await remember()).status).toBe(200);
    expect(ledger(store).films.m1).toMatchObject({
      showing: true,
      venues: ["rio"],
    });
    // The runs are the reader's history, and kept.
    expect(ledger(store).runs).toHaveLength(1);
  });

  it("logs that it remembered, never what", async () => {
    serve({ movies: () => [], store: reader("u1", { m1: "Halloween" }) });
    await remember();
    expect(logged(log, "alerts-remembered")).toEqual([
      { event: "alerts-remembered", uid: "u1", films: 1 },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Halloween");
  });
});

describe("remembering is refused", () => {
  it("while alerts are off", async () => {
    const store = reader("u1", { m1: "Halloween" }, { enabled: false });
    serve({ movies: () => [], store });
    expect((await remember()).status).toBe(409);
    expect(store["users/u1/meta/alert-ledger"]).toBeUndefined();
  });

  it("without the capability", async () => {
    const store = reader("u1", { m1: "Halloween" });
    delete store["users/u1/meta/capabilities"];
    serve({ movies: () => [], store });
    expect((await remember()).status).toBe(403);
  });

  it("without a sign-in", async () => {
    serve({ movies: () => [], store: reader("u1", {}) });
    expect((await remember("u1", null)).status).toBe(401);
  });

  it("when the listings can't be read, saying so", async () => {
    serve({ movies: () => [], store: reader("u1", {}), siteStatus: 503 });
    expect((await remember()).status).toBe(503);
  });
});
