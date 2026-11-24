import { describe, expect, it } from "vitest";
import { MAX_FILMS, MAX_TIMES, MAX_VENUES, renderDigest } from "../src/digest";
import { everythingShowing, type FilmNews } from "../src/news";
import { at, film, listings, NOW } from "./fixtures";

const SITE = "https://clusterflick.com";
const SETTINGS = `${SITE}/personalise/alerts/`;

function render(
  data: ReturnType<typeof listings>,
  news: FilmNews[],
  extra: { unsubscribeUrl?: string; titles?: Record<string, string> } = {},
) {
  return renderDigest({
    data,
    news,
    titles: extra.titles ?? {},
    siteOrigin: SITE,
    settingsUrl: SETTINGS,
    unsubscribeUrl: extra.unsubscribeUrl,
    now: NOW,
  });
}

describe("one film", () => {
  const data = listings(
    film("m1", "Halloween", { rio: [at(1, 19.5)], pcc: [at(2, 20)] }),
  );

  it("is the subject, with what's new about it", () => {
    const digest = render(data, everythingShowing(data, new Set(["m1"]), NOW));
    expect(digest.subject).toBe("Halloween: Now showing");
    expect(digest.films).toBe(1);
  });

  it("lists a line per venue, soonest first, linking to its page", () => {
    const { text, html } = render(
      data,
      everythingShowing(data, new Set(["m1"]), NOW),
    );
    expect(text).toContain("  Rio Cinema: Tomorrow 19:30\n");
    expect(text).toContain("  Prince Charles Cinema: Wed 20:00\n");
    expect(text.indexOf("Rio Cinema")).toBeLessThan(
      text.indexOf("Prince Charles"),
    );
    expect(text).toContain(`${SITE}/movies/m1/halloween`);
    expect(html).toContain(`href="${SITE}/movies/m1/halloween"`);
  });

  it("links each venue to the film's page filtered to it, with every date", () => {
    const { html } = render(
      data,
      everythingShowing(data, new Set(["m1"]), NOW),
    );
    expect(html).toContain(
      `<a href="${SITE}/movies/m1/halloween?base=all&amp;venues=rio" style="color:#e4a11b;">Rio Cinema</a>: Tomorrow 19:30`,
    );
  });

  it("names new venues, and counts new showings", () => {
    const { subject } = render(data, [
      {
        filmId: "m1",
        firstListing: false,
        newVenues: ["pcc"],
        newPerformances: 2,
        occurrences: [],
      },
    ]);
    expect(subject).toBe(
      "Halloween: Now also at Prince Charles Cinema · 2 new showings",
    );
  });
});

describe("a longer email", () => {
  it("names the soonest of equals in the subject and counts the rest", () => {
    const data = listings(
      film("m1", "Halloween", { rio: [at(1, 19)] }),
      film("m2", "Cléo from 5 to 7", { bfi: [at(1, 14)] }),
      film("m3", "The Gleaners and I", { bfi: [at(2, 14)] }),
    );
    const digest = render(
      data,
      everythingShowing(data, new Set(["m1", "m2", "m3"]), NOW),
    );
    expect(digest.subject).toBe(
      "Cléo from 5 to 7 and 2 more films from your watchlist",
    );
  });

  it(`stops at ${MAX_FILMS} films and ${MAX_TIMES} times a venue, counting the rest`, () => {
    const films = Array.from({ length: MAX_FILMS + 2 }, (_, n) =>
      film(`m${n + 10}`, `Film ${n + 10}`, {
        rio: [at(1, 12), at(1, 15), at(1, 18), at(1, 21)],
      }),
    );
    const data = listings(...films);
    const digest = render(
      data,
      everythingShowing(data, new Set(films.map(({ id }) => id)), NOW),
    );
    expect(digest.films).toBe(MAX_FILMS + 2);
    expect(digest.text).toContain("And 2 more films");
    expect(digest.text).toContain(
      "  Rio Cinema: Tomorrow 12:00, 15:00, 18:00 and 1 more\n",
    );
    expect(digest.text.match(/ {2}Rio Cinema:/g)).toHaveLength(MAX_FILMS);
  });
});

describe("the order", () => {
  // A wide release reaching four more multiplexes, a film at one venue
  // reaching a second, and two first listings. Their ids sort as text in
  // the opposite order to what's interesting about them.
  const data = listings(
    film("1", "Wide Release", {
      rio: [at(1, 12)],
      pcc: [at(1, 13)],
      bfi: [at(1, 14)],
      ica: [at(1, 15)],
      barbican: [at(1, 16)],
    }),
    film("2", "The Small One", { rio: [at(3, 18)], ica: [at(4, 18)] }),
    film("8009", "Highlander", { bfi: [at(9, 20)] }),
    film("947", "Arrival", { pcc: [at(9, 20)] }),
  );
  const news: FilmNews[] = [
    {
      filmId: "1",
      firstListing: false,
      newVenues: ["pcc", "bfi", "ica", "barbican"],
      newPerformances: 0,
      occurrences: [
        { listing: data.movies["1"], venueId: "pcc", time: at(1, 13) },
        { listing: data.movies["1"], venueId: "bfi", time: at(1, 14) },
        { listing: data.movies["1"], venueId: "ica", time: at(1, 15) },
        { listing: data.movies["1"], venueId: "barbican", time: at(1, 16) },
      ],
    },
    {
      filmId: "2",
      firstListing: false,
      newVenues: ["ica"],
      newPerformances: 0,
      occurrences: [
        { listing: data.movies["2"], venueId: "ica", time: at(4, 18) },
      ],
    },
    ...everythingShowing(data, new Set(["8009", "947"]), NOW),
  ];

  it("names a first listing in the subject before a film reaching new venues", () => {
    expect(render(data, news).subject).toBe(
      "Arrival and 3 more films from your watchlist",
    );
  });

  it("lists first listings, then new venues, alphabetically in each", () => {
    const { text } = render(data, news);
    const order = ["Arrival", "Highlander", "The Small One", "Wide Release"];
    const found = order.map((title) => text.indexOf(`${title}\n`));
    expect(found).toEqual([...found].sort((a, b) => a - b));
    expect(found).not.toContain(-1);
  });

  it("leaves out the least interesting when there are too many", () => {
    const many = [
      ...news,
      ...Array.from({ length: MAX_FILMS - 3 }, (_, n) => ({
        ...news[2],
        filmId: `x${n}`,
      })),
    ];
    const extra = listings(
      ...Object.values(data.movies),
      ...many
        .slice(4)
        .map(({ filmId }) =>
          film(filmId, `Extra ${filmId}`, { bfi: [at(9, 20)] }),
        ),
    );
    const { text } = render(extra, many);
    expect(text).toContain("The Small One\n");
    expect(text).not.toContain("Wide Release\n");
    expect(text).toContain("And 1 more film");
  });

  it(`names ${MAX_VENUES} venues and links the rest, filtered to the new ones`, () => {
    const { text, html } = render(data, news);
    expect(text).toContain("  and 1 more cinema\n");
    expect(html).toContain(
      `href="${SITE}/movies/1/wide-release?base=all&amp;venues=pcc,bfi,ica,barbican"`,
    );
  });

  it("names the day only when it changes", () => {
    const busy = listings(
      film("m1", "Halloween", { rio: [at(1, 13), at(1, 15), at(2, 11)] }),
    );
    const { text } = render(
      busy,
      everythingShowing(busy, new Set(["m1"]), NOW),
    );
    expect(text).toContain("  Rio Cinema: Tomorrow 13:00, 15:00, Wed 11:00\n");
  });
});

describe("a film inside an event", () => {
  it("says which event, and links to it", () => {
    const data = listings(
      film(
        "e1",
        "Carpenter Double Bill",
        { pcc: [at(3, 19)] },
        { includedMovies: [{ id: "m1", title: "Halloween" }] },
      ),
    );
    const { text } = render(
      data,
      everythingShowing(data, new Set(["m1"]), NOW),
    );
    expect(text).toContain("Halloween\nNow showing");
    expect(text).toContain("(in Carpenter Double Bill)");
    expect(text).toContain(`${SITE}/movies/e1/carpenter-double-bill`);
  });
});

describe("the footer", () => {
  const data = listings(film("m1", "Halloween", { rio: [at(1, 19)] }));
  const news = everythingShowing(data, new Set(["m1"]), NOW);

  it("says why, and links to the settings", () => {
    const { text } = render(data, news);
    expect(text).toContain("you switched on email alerts");
    expect(text).toContain(`Edit your alerts: ${SETTINGS}`);
  });

  it("has an unsubscribe link only when there is one", () => {
    expect(render(data, news).text).not.toContain("Unsubscribe");
    expect(
      render(data, news, { unsubscribeUrl: "https://x.example/u" }).text,
    ).toContain("Unsubscribe: https://x.example/u");
  });
});

it("escapes what it puts in the HTML", () => {
  const data = listings(
    film("m1", `<script>"Rocky" & Bullwinkle</script>`, { rio: [at(1, 19)] }),
  );
  const { html } = render(data, everythingShowing(data, new Set(["m1"]), NOW));
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;&quot;Rocky&quot; &amp; Bullwinkle");
});
