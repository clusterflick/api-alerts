import { describe, expect, it } from "vitest";
import { MAX_FILMS, MAX_SHOWINGS, renderDigest } from "../src/digest";
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

  it("lists its showings soonest first, each with the venue, linking to its page", () => {
    const { text, html } = render(
      data,
      everythingShowing(data, new Set(["m1"]), NOW),
    );
    expect(text).toContain("Tomorrow 19:30 · Rio Cinema");
    expect(text).toContain("Wed 20:00 · Prince Charles Cinema");
    expect(text.indexOf("Rio Cinema")).toBeLessThan(
      text.indexOf("Prince Charles"),
    );
    expect(text).toContain(`${SITE}/movies/m1/halloween`);
    expect(html).toContain(`href="${SITE}/movies/m1/halloween"`);
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
  it("names the first film and counts the rest in the subject", () => {
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
      "Halloween and 2 more films from your watchlist",
    );
  });

  it(`stops at ${MAX_FILMS} films and ${MAX_SHOWINGS} showings, counting the rest`, () => {
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
    expect(digest.text).toContain("and 1 more showing");
    expect(digest.text.match(/· Rio Cinema/g)).toHaveLength(
      MAX_FILMS * MAX_SHOWINGS,
    );
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
