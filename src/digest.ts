import type { CinemaData } from "@clusterflick/catalogue/types";
import {
  formatRelativeDay,
  formatShowingTime,
} from "@clusterflick/catalogue/utils/format-date";
import { getMovieUrl } from "@clusterflick/catalogue/utils/get-movie-url";
import type { FilmNews } from "./news";

/**
 * A night's news as an email: grouped by film, each film's title linking to
 * its page, what's new about it, and its first few showings. Kept plain, so
 * it reads the same in every mail client, with a text version beside it.
 */

/** Films in one email; the rest are counted and linked. */
export const MAX_FILMS = 10;
/** Venues listed under each film, a line each; the rest are counted. */
export const MAX_VENUES = 3;
/** Performances on each venue's line; the rest are counted. */
export const MAX_TIMES = 3;

export type Digest = {
  subject: string;
  html: string;
  text: string;
  /** How many films it's about. */
  films: number;
};

export type DigestOptions = {
  data: CinemaData;
  news: FilmNews[];
  /** Titles from the watchlist, for a film only listed inside an event. */
  titles: Record<string, string>;
  siteOrigin: string;
  /** Where "Edit alerts" goes. */
  settingsUrl: string;
  /** Absent in a preview, which nobody can unsubscribe from. */
  unsubscribeUrl?: string;
  now: number;
};

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "Rio Cinema, Prince Charles Cinema and 2 more" */
function listNames(names: string[], max: number): string {
  if (names.length <= max) {
    return names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/**
 * How news ranks, most interesting first: a film showing again after a
 * month away, then one reaching somewhere new, then new showings where it
 * already was.
 */
const tier = (item: FilmNews) =>
  item.firstListing ? 0 : item.newVenues.length > 0 ? 1 : 2;

/** Every venue a film is showing at, not only the ones the news is about. */
function venuesShowing(item: FilmNews, data: CinemaData): number {
  const own = data.movies[item.filmId];
  const venues = new Set(item.occurrences.map(({ venueId }) => venueId));
  for (const showing of Object.values(own?.showings ?? {})) {
    venues.add(showing.venueId);
  }
  return venues.size;
}

/**
 * The news, most interesting first, which decides the films that fit and
 * the one the subject names. Within a tier, a film at fewer venues is
 * rarer, and so the bigger news: a third venue for a film at two beats an
 * eighteenth for a wide release. Then the soonest showing, then the title,
 * so the order never depends on the films' ids.
 */
export function rankNews(
  news: readonly FilmNews[],
  data: CinemaData,
  titleOf: (item: FilmNews) => string,
): FilmNews[] {
  const soonest = (item: FilmNews) =>
    item.occurrences[0]?.time ?? Number.POSITIVE_INFINITY;
  return [...news].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      venuesShowing(a, data) - venuesShowing(b, data) ||
      soonest(a) - soonest(b) ||
      compareTitles(titleOf(a), titleOf(b)),
  );
}

/** Alphabetical as a reader files it: "The Fly" under F. */
const sortTitle = (title: string) => title.replace(/^(the|a|an)\s+/i, "");
const compareTitles = (a: string, b: string) =>
  sortTitle(a).localeCompare(sortTitle(b), "en-GB", { sensitivity: "base" });

/** The film page, filtered to these venues, with every date. */
function filteredUrl(pageUrl: string, venueIds: readonly string[]): string {
  // Each id encoded on its own so the separating commas stay readable, as
  // the site's own filter links do.
  const venues = venueIds.map(encodeURIComponent).join(",");
  return `${pageUrl}?base=all&venues=${venues}`;
}

type VenueLine = {
  /** "Rio Cinema", or "Rio Cinema (in Carpenter Double Bill)". */
  label: string;
  /** "Tomorrow 19:30, 21:00, Wed 18:00" */
  times: string;
  moreTimes: number;
  url: string;
};

type FilmEntry = {
  title: string;
  url: string;
  headline: string;
  venues: VenueLine[];
  moreVenues: number;
  /** Where "and N more cinemas" goes. */
  moreVenuesUrl: string;
};

/** "Fri 13:30, 15:10, Sat 11:00": the day named only when it changes. */
function formatTimes(times: number[], now: number): string {
  let lastDay = "";
  return times
    .map((time) => {
      const day = formatRelativeDay(time, now, { weekday: "short" });
      const shown =
        day === lastDay
          ? formatShowingTime(time)
          : `${day} ${formatShowingTime(time)}`;
      lastDay = day;
      return shown;
    })
    .join(", ");
}

function titleOf(item: FilmNews, { data, titles }: DigestOptions): string {
  return (
    data.movies[item.filmId]?.title ??
    titles[item.filmId] ??
    item.occurrences[0]?.listing.includedMovies?.find(
      ({ id }) => id === item.filmId,
    )?.title ??
    "A film on your watchlist"
  );
}

function describeFilm(item: FilmNews, options: DigestOptions): FilmEntry {
  const { data, siteOrigin, now } = options;
  const own = data.movies[item.filmId];
  // Its own page when it's listed as itself; otherwise the event showing it.
  const page = own ?? item.occurrences[0]?.listing;
  const url = page ? `${siteOrigin}${getMovieUrl(page)}` : siteOrigin;
  const venueName = (id: string) => data.venues[id]?.name ?? id;

  const parts: string[] = [];
  if (item.firstListing) parts.push("Now showing");
  if (item.newVenues.length > 0) {
    parts.push(
      `Now also at ${listNames(item.newVenues.map(venueName), MAX_VENUES)}`,
    );
  }
  if (item.newPerformances > 0) {
    parts.push(plural(item.newPerformances, "new showing"));
  }

  // One line per venue, and per event at it, in the order of each one's
  // soonest showing: the occurrences come soonest first.
  const groups = new Map<
    string,
    {
      listing: FilmNews["occurrences"][number]["listing"];
      venueId: string;
      times: number[];
    }
  >();
  for (const { listing, venueId, time } of item.occurrences) {
    const groupKey = `${venueId}\u0000${listing.id}`;
    const group = groups.get(groupKey) ?? { listing, venueId, times: [] };
    group.times.push(time);
    groups.set(groupKey, group);
  }
  const lines = [...groups.values()].map(
    ({ listing, venueId, times }): VenueLine => {
      const within = listing.id === item.filmId ? "" : ` (in ${listing.title})`;
      return {
        label: `${venueName(venueId)}${within}`,
        times: formatTimes(times.slice(0, MAX_TIMES), now),
        moreTimes: Math.max(0, times.length - MAX_TIMES),
        url: filteredUrl(`${siteOrigin}${getMovieUrl(listing)}`, [venueId]),
      };
    },
  );
  const venueIds = [...new Set(item.occurrences.map(({ venueId }) => venueId))];
  return {
    title: titleOf(item, options),
    url,
    headline: parts.join(" · "),
    venues: lines.slice(0, MAX_VENUES),
    moreVenues: Math.max(0, lines.length - MAX_VENUES),
    // A first listing is news everywhere it's showing; otherwise only the
    // venues the news is about.
    moreVenuesUrl: item.firstListing ? url : filteredUrl(url, venueIds),
  };
}

export function renderDigest(options: DigestOptions): Digest {
  const { news, data, siteOrigin, settingsUrl, unsubscribeUrl } = options;
  const ranked = rankNews(news, data, (item) => titleOf(item, options));
  // The most interesting make the cut, and the most interesting of all is
  // the subject; the email then reads in tiers, alphabetically in each, so a
  // film is easy to find.
  const shown = ranked
    .slice(0, MAX_FILMS)
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        compareTitles(titleOf(a, options), titleOf(b, options)),
    );
  const entries = shown.map((n) => describeFilm(n, options));
  const moreFilms = news.length - entries.length;
  const lead = ranked[0] && describeFilm(ranked[0], options);

  const subject =
    entries.length === 1
      ? `${lead.title}: ${lead.headline}`
      : `${lead.title} and ${plural(news.length - 1, "more film")} from your watchlist`;

  const watchlistUrl = `${siteOrigin}/personalise/`;
  const why =
    "You're getting this because you switched on email alerts for your watchlist at Clusterflick.";

  const text = [
    ...entries.flatMap((entry) => [
      entry.title,
      entry.headline,
      ...entry.venues.map(
        (line) =>
          `  ${line.label}: ${line.times}${line.moreTimes > 0 ? ` and ${line.moreTimes} more` : ""}`,
      ),
      ...(entry.moreVenues > 0
        ? [`  and ${plural(entry.moreVenues, "more cinema")}`]
        : []),
      `  ${entry.url}`,
      "",
    ]),
    ...(moreFilms > 0
      ? [`And ${plural(moreFilms, "more film")}: ${watchlistUrl}`, ""]
      : []),
    "--",
    why,
    `Edit your alerts: ${settingsUrl}`,
    ...(unsubscribeUrl ? [`Unsubscribe: ${unsubscribeUrl}`] : []),
  ].join("\n");

  const link = (href: string, label: string, style = "") =>
    `<a href="${escape(href)}" style="color:#e4a11b;${style}">${escape(label)}</a>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:24px 16px;background:#111;color:#eee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;">
<div style="max-width:560px;margin:0 auto;">
${entries
  .map(
    (entry) => `<div style="margin:0 0 24px;">
<h2 style="margin:0;font-size:20px;line-height:1.3;">${link(entry.url, entry.title, "text-decoration:none;")}</h2>
<p style="margin:2px 0 8px;color:#bbb;">${escape(entry.headline)}</p>
<ul style="margin:0;padding:0 0 0 18px;">${entry.venues
      .map(
        (line) =>
          `<li>${link(line.url, line.label)}: ${escape(line.times)}${
            line.moreTimes > 0 ? ` and ${line.moreTimes} more` : ""
          }</li>`,
      )
      .join("")}${
      entry.moreVenues > 0
        ? `<li>${link(entry.moreVenuesUrl, `and ${plural(entry.moreVenues, "more cinema")}`)}</li>`
        : ""
    }</ul>
</div>`,
  )
  .join("\n")}
${
  moreFilms > 0
    ? `<p style="margin:0 0 24px;">${link(watchlistUrl, `And ${plural(moreFilms, "more film")} on your watchlist`)}</p>`
    : ""
}<hr style="border:0;border-top:1px solid #333;margin:24px 0 12px;">
<p style="margin:0;font-size:13px;color:#999;">${escape(why)}<br>${link(settingsUrl, "Edit your alerts")}${
    unsubscribeUrl ? ` · ${link(unsubscribeUrl, "Unsubscribe")}` : ""
  }</p>
</div>
</body></html>`;

  return { subject, html, text, films: news.length };
}
