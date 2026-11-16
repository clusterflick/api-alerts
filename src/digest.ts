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
/** Showings under each film; the rest are on its page. */
export const MAX_SHOWINGS = 3;
/** Venues named in a film's headline; the rest are counted. */
const MAX_VENUES = 3;

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

type FilmEntry = {
  title: string;
  url: string;
  headline: string;
  showings: string[];
  moreShowings: number;
};

function describeFilm(
  item: FilmNews,
  { data, titles, siteOrigin, now }: DigestOptions,
): FilmEntry {
  const own = data.movies[item.filmId];
  const title =
    own?.title ??
    titles[item.filmId] ??
    item.occurrences[0]?.listing.includedMovies?.find(
      ({ id }) => id === item.filmId,
    )?.title ??
    "A film on your watchlist";
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

  const showings = item.occurrences
    .slice(0, MAX_SHOWINGS)
    .map(({ listing, venueId, time }) => {
      const within = listing.id === item.filmId ? "" : ` (in ${listing.title})`;
      return `${formatRelativeDay(time, now, { weekday: "short" })} ${formatShowingTime(time)} · ${venueName(venueId)}${within}`;
    });
  return {
    title,
    url,
    headline: parts.join(" · "),
    showings,
    moreShowings: Math.max(0, item.occurrences.length - MAX_SHOWINGS),
  };
}

export function renderDigest(options: DigestOptions): Digest {
  const { news, siteOrigin, settingsUrl, unsubscribeUrl } = options;
  const entries = news.slice(0, MAX_FILMS).map((n) => describeFilm(n, options));
  const moreFilms = news.length - entries.length;
  const [first] = entries;

  const subject =
    entries.length === 1
      ? `${first.title}: ${first.headline}`
      : `${first.title} and ${plural(news.length - 1, "more film")} from your watchlist`;

  const watchlistUrl = `${siteOrigin}/personalise/`;
  const why =
    "You're getting this because you switched on email alerts for your watchlist at Clusterflick.";

  const text = [
    ...entries.flatMap((entry) => [
      entry.title,
      entry.headline,
      ...entry.showings.map((line) => `  ${line}`),
      ...(entry.moreShowings > 0
        ? [`  and ${plural(entry.moreShowings, "more showing")}`]
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
<ul style="margin:0;padding:0 0 0 18px;">${entry.showings
      .map((line) => `<li>${escape(line)}</li>`)
      .join("")}${
      entry.moreShowings > 0
        ? `<li>${link(entry.url, `and ${plural(entry.moreShowings, "more showing")}`)}</li>`
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
