import { describe, expect, it } from "vitest";
import {
  everythingShowing,
  findNews,
  PUBLISH_LAG_MS,
  readMemory,
  type Memory,
} from "../src/news";
import { at, dayFrom, film, listings, NOW, TODAY } from "./fixtures";

const QUIET = ["firstListing", "newVenue"] as const;
const ALL = ["firstListing", "newVenue", "newPerformance"] as const;

const halloween = (venues: Record<string, number[]>) =>
  film("m1", "Halloween", venues);

function run(
  data: ReturnType<typeof listings>,
  memory: Memory,
  triggers: readonly ("firstListing" | "newVenue" | "newPerformance")[] = QUIET,
  { watchlist = ["m1"], today = TODAY, now = NOW } = {},
) {
  return findNews({
    data,
    watchlist: new Set(watchlist),
    memory,
    triggers,
    today,
    now,
  });
}

describe("a film the ledger doesn't know yet", () => {
  it("is remembered as it stands, and isn't news", () => {
    const { news, memory } = run(
      listings(halloween({ rio: [at(1, 19)], pcc: [at(2, 20)] })),
      {},
    );
    expect(news).toEqual([]);
    expect(memory.m1).toEqual({
      showing: true,
      lastShowing: TODAY,
      venues: ["rio", "pcc"],
    });
  });

  it("not showing, is remembered as not showing", () => {
    const { news, memory } = run(listings(), {});
    expect(news).toEqual([]);
    expect(memory.m1).toEqual({ showing: false, venues: [] });
  });
});

describe("first listing", () => {
  it("is a film that wasn't showing since it went on the watchlist", () => {
    const { news, memory } = run(
      listings(halloween({ rio: [at(1, 19)], pcc: [at(2, 20)] })),
      { m1: { showing: false, venues: [] } },
    );
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({
      filmId: "m1",
      firstListing: true,
      newVenues: [],
    });
    // Every performance: it's all new.
    expect(news[0].occurrences.map(({ venueId }) => venueId)).toEqual([
      "rio",
      "pcc",
    ]);
    expect(memory.m1.venues).toEqual(["rio", "pcc"]);
  });

  it("is a film back after more than 30 days, which starts its venues again", () => {
    const { news, memory } = run(listings(halloween({ rio: [at(1, 19)] })), {
      m1: { showing: false, lastShowing: dayFrom(-31), venues: ["pcc"] },
    });
    expect(news[0]).toMatchObject({ firstListing: true, newVenues: [] });
    expect(memory.m1.venues).toEqual(["rio"]);
  });

  it("isn't a film back within 30 days: a new venue is, and a known one isn't", () => {
    const back = run(listings(halloween({ rio: [at(1, 19)] })), {
      m1: { showing: false, lastShowing: dayFrom(-30), venues: ["rio"] },
    });
    expect(back.news).toEqual([]);
    const elsewhere = run(listings(halloween({ pcc: [at(1, 19)] })), {
      m1: { showing: false, lastShowing: dayFrom(-30), venues: ["rio"] },
    });
    expect(elsewhere.news[0]).toMatchObject({
      firstListing: false,
      newVenues: ["pcc"],
    });
    expect(elsewhere.memory.m1.venues).toEqual(["rio", "pcc"]);
  });

  it("isn't news when that trigger's off, and is still remembered", () => {
    const { news, memory } = run(
      listings(halloween({ rio: [at(1, 19)] })),
      { m1: { showing: false, venues: [] } },
      ["newVenue"],
    );
    expect(news).toEqual([]);
    expect(memory.m1.showing).toBe(true);
  });
});

describe("a new venue", () => {
  const known: Memory = {
    m1: { showing: true, lastShowing: dayFrom(-1), venues: ["rio"] },
  };

  it("is news, with only that venue's showings", () => {
    const { news, memory } = run(
      listings(halloween({ rio: [at(1, 19)], pcc: [at(2, 20)] })),
      known,
    );
    expect(news).toHaveLength(1);
    expect(news[0]).toMatchObject({ firstListing: false, newVenues: ["pcc"] });
    expect(news[0].occurrences.map(({ venueId }) => venueId)).toEqual(["pcc"]);
    expect(memory.m1.venues).toEqual(["rio", "pcc"]);
  });

  it("isn't news twice", () => {
    const first = run(
      listings(halloween({ rio: [at(1, 19)], pcc: [at(2, 20)] })),
      known,
    );
    const second = run(
      listings(halloween({ rio: [at(1, 19)], pcc: [at(2, 20)] })),
      first.memory,
    );
    expect(second.news).toEqual([]);
  });

  it("isn't news when that trigger's off, and is still remembered", () => {
    const { news, memory } = run(
      listings(halloween({ rio: [at(1, 19)], pcc: [at(2, 20)] })),
      known,
      ["firstListing"],
    );
    expect(news).toEqual([]);
    expect(memory.m1.venues).toEqual(["rio", "pcc"]);
  });

  it("is a venue left and come back to only once", () => {
    const { news } = run(listings(halloween({ rio: [at(1, 19)] })), {
      m1: { showing: true, lastShowing: dayFrom(-1), venues: ["rio", "pcc"] },
    });
    expect(news).toEqual([]);
  });
});

describe("a new performance", () => {
  it("is remembered first when the trigger's switched on, not reported", () => {
    const { news, memory } = run(
      listings(halloween({ rio: [at(1, 19), at(2, 19)] })),
      { m1: { showing: true, lastShowing: dayFrom(-1), venues: ["rio"] } },
      ALL,
    );
    expect(news).toEqual([]);
    expect(memory.m1.performances).toHaveLength(2);
  });

  it("is news once the performances are remembered, counted", () => {
    const before = run(
      listings(halloween({ rio: [at(1, 19)] })),
      { m1: { showing: true, lastShowing: dayFrom(-1), venues: ["rio"] } },
      ALL,
    );
    const { news } = run(
      listings(halloween({ rio: [at(1, 19), at(2, 19), at(3, 19)] })),
      before.memory,
      ALL,
    );
    expect(news[0]).toMatchObject({ newPerformances: 2, newVenues: [] });
    expect(news[0].occurrences.map(({ time }) => time)).toEqual([
      at(2, 19),
      at(3, 19),
    ]);
  });

  it("isn't kept when the trigger's off, so the ledger stays small", () => {
    const { memory } = run(listings(halloween({ rio: [at(1, 19)] })), {
      m1: {
        showing: true,
        lastShowing: dayFrom(-1),
        venues: ["rio"],
        performances: ["rio@1"],
      },
    });
    expect(memory.m1.performances).toBeUndefined();
  });
});

describe("the watchlist", () => {
  it("counts a film screened inside an event", () => {
    const doubleBill = film(
      "e1",
      "Carpenter Double Bill",
      { pcc: [at(3, 19)] },
      {
        includedMovies: [
          { id: "m1", title: "Halloween" },
          { id: "m9", title: "The Fog" },
        ],
      },
    );
    const { news } = run(listings(doubleBill), {
      m1: { showing: false, venues: [] },
    });
    expect(news[0]).toMatchObject({ filmId: "m1", firstListing: true });
    expect(news[0].occurrences[0].listing.id).toBe("e1");
  });

  it("ignores performances that have already started", () => {
    const { news, memory } = run(listings(halloween({ rio: [NOW - 1, NOW] })), {
      m1: { showing: false, venues: [] },
    });
    expect(news).toEqual([]);
    expect(memory.m1.showing).toBe(false);
  });

  it("forgets a film taken off it, so adding it back starts afresh", () => {
    const { memory } = run(listings(), {
      m1: { showing: false, venues: [] },
      m2: { showing: true, lastShowing: dayFrom(-1), venues: ["rio"] },
    });
    expect(Object.keys(memory)).toEqual(["m1"]);
  });
});

describe("a film added since the last run", () => {
  const HOUR = 3_600_000;
  /** Last night's run, and the film added this morning. */
  const LAST_RUN = NOW - 24 * HOUR;
  const ADDED = NOW - 10 * HOUR;

  function added(
    data: ReturnType<typeof listings>,
    {
      since = LAST_RUN as number | null,
      addedAt = ADDED,
      memory = {} as Memory,
      triggers = QUIET as readonly (
        "firstListing" | "newVenue" | "newPerformance"
      )[],
    } = {},
  ) {
    return findNews({
      data,
      watchlist: new Set(["m1"]),
      memory,
      triggers,
      today: TODAY,
      now: NOW,
      addedAt: { m1: addedAt },
      since: since ?? undefined,
    });
  }

  it("listed only after it was added, is first listed", () => {
    const { news, memory } = added(
      listings(
        film(
          "m1",
          "Halloween",
          { rio: [at(1, 19)] },
          {},
          { rio: NOW - 2 * HOUR },
        ),
      ),
    );
    expect(news[0]).toMatchObject({ filmId: "m1", firstListing: true });
    expect(memory.m1).toMatchObject({ showing: true, venues: ["rio"] });
  });

  it("first seen a little before it was added, still wasn't on the site, and is news", () => {
    const { news } = added(
      listings(
        film(
          "m1",
          "Halloween",
          { rio: [at(1, 19)] },
          {},
          { rio: ADDED - PUBLISH_LAG_MS + HOUR },
        ),
      ),
    );
    expect(news[0]).toMatchObject({ firstListing: true });
  });

  it("already showing when it was added, isn't news: it was on the site", () => {
    const { news, memory } = added(
      listings(
        film(
          "m1",
          "Halloween",
          { rio: [at(1, 19)] },
          {},
          { rio: ADDED - PUBLISH_LAG_MS - HOUR },
        ),
      ),
    );
    expect(news).toEqual([]);
    expect(memory.m1.showing).toBe(true);
  });

  it("already showing, reaching a venue after it was added, has that venue as news", () => {
    const { news } = added(
      listings(
        film(
          "m1",
          "Halloween",
          { rio: [at(1, 19)], pcc: [at(2, 20)] },
          {},
          { rio: ADDED - 2 * PUBLISH_LAG_MS, pcc: NOW - HOUR },
        ),
      ),
    );
    expect(news[0]).toMatchObject({ firstListing: false, newVenues: ["pcc"] });
    expect(news[0].occurrences.map(({ venueId }) => venueId)).toEqual(["pcc"]);
  });

  it.each([
    ["with nothing remembered before it", { since: null }],
    ["added before the last run", { addedAt: LAST_RUN - HOUR }],
  ])("isn't judged %s: it just starts here", (_, options) => {
    const { news } = added(
      listings(
        film("m1", "Halloween", { rio: [at(1, 19)] }, {}, { rio: NOW - HOUR }),
      ),
      options,
    );
    expect(news).toEqual([]);
  });

  it("isn't judged when a showing doesn't say when it was first seen", () => {
    const { news } = added(
      listings(
        film(
          "m1",
          "Halloween",
          { rio: [at(1, 19)], pcc: [at(2, 20)] },
          {},
          { rio: NOW - HOUR },
        ),
      ),
    );
    expect(news).toEqual([]);
  });

  it("isn't news when that trigger's off", () => {
    const { news } = added(
      listings(
        film("m1", "Halloween", { rio: [at(1, 19)] }, {}, { rio: NOW - HOUR }),
      ),
      { triggers: ["newVenue"] },
    );
    expect(news).toEqual([]);
  });
});

describe("everythingShowing", () => {
  it("is every watchlist film on now, each as if first listed", () => {
    const news = everythingShowing(
      listings(
        halloween({ rio: [at(1, 19)] }),
        film("m2", "Cléo from 5 to 7", { bfi: [at(1, 14)] }),
        film("m3", "Not On The Watchlist", { ica: [at(1, 14)] }),
      ),
      new Set(["m1", "m2", "m4"]),
      NOW,
    );
    expect(
      news.map(({ filmId, firstListing }) => [filmId, firstListing]),
    ).toEqual([
      ["m1", true],
      ["m2", true],
    ]);
  });
});

describe("readMemory", () => {
  it("keeps what it can read, and forgets the rest", () => {
    expect(
      readMemory({
        m1: {
          showing: true,
          lastShowing: TODAY,
          venues: ["rio", 3],
          performances: ["rio@1"],
        },
        m2: { showing: "yes" },
        m3: "x",
        m4: { showing: false, lastShowing: "yesterday", venues: "rio" },
      }),
    ).toEqual({
      m1: {
        showing: true,
        lastShowing: TODAY,
        venues: ["rio"],
        performances: ["rio@1"],
      },
      m4: { showing: false, venues: [] },
    });
  });
});
