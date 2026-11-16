import type { AlertTrigger } from "@clusterflick/accounts/alerts";
import type { CinemaData, Movie } from "@clusterflick/catalogue/types";
import {
  dateStringToLondonTimestamp,
  getLondonDaysBetween,
} from "@clusterflick/catalogue/utils/format-date";

/**
 * What's news about the films on a reader's watchlist: the listings as the
 * site publishes them now, against what the reader's ledger remembers of each
 * film from the last run. No change sets: the listings are what the reader
 * sees, with every venue a film is at, and the ledger is what they've been
 * told about, or saw was there already.
 *
 * A film the ledger doesn't know yet was added to the watchlist since the
 * last run, which knows nothing of what it was doing then. It's judged by
 * when it was added: showings the pipeline first saw after that are news
 * (`seen`, which the site's listings carry for each showing), and a film
 * already showing when it was added is one the reader was looking at on the
 * site. Without what that needs, it's remembered as it stands, and isn't news.
 */

/**
 * How long before a film was added a showing can have been first seen and
 * still not have been on the site: the pipeline sees a showing some hours
 * before the site publishes it, and someone adding a film in between added
 * one that wasn't on. Too long, and a film the reader saw on the site is
 * announced to them that night; too short, and one that wasn't is never
 * announced at all, which is the worse of the two.
 */
export const PUBLISH_LAG_MS = 6 * 60 * 60_000;

/** A film's place in the ledger: what the last run saw of it. */
export type FilmMemory = {
  /** Whether it was showing at the last run. */
  showing: boolean;
  /** The last London date a run saw it showing, `YYYY-MM-DD`. */
  lastShowing?: string;
  /** Every venue it has been seen at since it was last first listed. */
  venues: string[];
  /**
   * Its performances still to come, as `venueId@time`: kept only while the
   * reader is told about every new one, so the ledger stays small otherwise.
   */
  performances?: string[];
};

export type Memory = Record<string, FilmMemory>;

/** Days a film must be gone for its return to be a first listing. */
export const FIRST_LISTING_GAP_DAYS = 30;

/** One performance of a watchlist film, wherever it's listed. */
export type Occurrence = {
  /** The listing it's in: the film itself, or an event screening it. */
  listing: Movie;
  venueId: string;
  time: number;
  /** When the pipeline first saw its showing, epoch ms, when it says. */
  seen?: number;
};

export type FilmNews = {
  /** The watchlist's id for it, which is the listings' id for the film. */
  filmId: string;
  firstListing: boolean;
  /** Venues it's showing at for the first time, not counting a first listing. */
  newVenues: string[];
  /** How many new performances, when the reader is told about them. */
  newPerformances: number;
  /** The performances the news is about, soonest first. */
  occurrences: Occurrence[];
};

export type NewsResult = {
  news: FilmNews[];
  /** The memory to keep once the news has been sent. */
  memory: Memory;
};

const key = ({ venueId, time }: Pick<Occurrence, "venueId" | "time">) =>
  `${venueId}@${time}`;

/**
 * Every performance still to come of each watchlist film, found under its own
 * listing and in any event that screens it (a double bill, a marathon).
 */
export function findOccurrences(
  data: CinemaData,
  filmIds: ReadonlySet<string>,
  now: number,
): Map<string, Occurrence[]> {
  const found = new Map<string, Occurrence[]>();
  for (const listing of Object.values(data.movies)) {
    const screened = [
      listing.id,
      ...(listing.includedMovies ?? []).map(({ id }) => id),
    ].filter((id) => filmIds.has(id));
    if (screened.length === 0) continue;
    for (const performance of listing.performances) {
      if (performance.time <= now) continue;
      const showing = listing.showings[performance.showingId];
      if (!showing) continue;
      for (const filmId of new Set(screened)) {
        const list = found.get(filmId) ?? [];
        list.push({
          listing,
          venueId: showing.venueId,
          time: performance.time,
          ...(typeof showing.seen === "number" && { seen: showing.seen }),
        });
        found.set(filmId, list);
      }
    }
  }
  for (const list of found.values()) list.sort((a, b) => a.time - b.time);
  return found;
}

/**
 * The news for one reader, and the memory to keep after it's sent. `today`
 * is the run's London date, `now` the instant performances must be after.
 */
export function findNews({
  data,
  watchlist,
  memory,
  triggers,
  today,
  now,
  addedAt = {},
  since,
}: {
  data: CinemaData;
  watchlist: ReadonlySet<string>;
  memory: Memory;
  triggers: readonly AlertTrigger[];
  today: string;
  now: number;
  /** When each watchlist film was added, epoch ms. */
  addedAt?: Record<string, number>;
  /**
   * When the ledger last remembered the watchlist: the last run, or alerts
   * switched on. A film it doesn't know, added after this, is judged by when
   * it was added; without it, any film it doesn't know just starts here.
   */
  since?: number;
}): NewsResult {
  const on = new Set(triggers);
  const occurrencesOf = findOccurrences(data, watchlist, now);
  const news: FilmNews[] = [];
  const next: Memory = {};

  // Films no longer on the watchlist are forgotten, so adding one back
  // starts afresh.
  for (const filmId of [...watchlist].sort()) {
    const occurrences = occurrencesOf.get(filmId) ?? [];
    const showing = occurrences.length > 0;
    const venues = [...new Set(occurrences.map(({ venueId }) => venueId))];
    const keys = occurrences.map(key);
    const known = memory[filmId];

    const remembered: FilmMemory = {
      showing,
      ...((showing ? today : known?.lastShowing) && {
        lastShowing: showing ? today : known?.lastShowing,
      }),
      venues,
      ...(on.has("newPerformance") && { performances: keys }),
    };

    if (!known) {
      const added = addedAt[filmId];
      const sinceAdded =
        showing && added && since !== undefined && added >= since
          ? sinceAddition(occurrences, added, on)
          : null;
      if (sinceAdded) news.push({ filmId, ...sinceAdded });
      next[filmId] = remembered;
      continue;
    }

    const gone =
      known.lastShowing === undefined ||
      getLondonDaysBetween(
        dateStringToLondonTimestamp(known.lastShowing),
        dateStringToLondonTimestamp(today),
      ) > FIRST_LISTING_GAP_DAYS;
    const returning = showing && !known.showing && gone;

    // Venues accumulate while the film keeps coming back within the gap, so
    // a venue it left and returns to isn't news twice; a first listing starts
    // the count again.
    if (!returning) {
      remembered.venues = [...new Set([...known.venues, ...venues])];
    }

    const knownVenues = new Set(known.venues);
    const newVenues = returning
      ? []
      : venues.filter((venueId) => !knownVenues.has(venueId));
    // Only once the performances have been remembered: switching the trigger
    // on remembers them first, rather than reporting every one as new.
    const knownKeys = known.performances && new Set(known.performances);
    const newKeys =
      on.has("newPerformance") && knownKeys && !returning
        ? keys.filter((k) => !knownKeys.has(k))
        : [];

    const firstListing = returning && on.has("firstListing");
    const atNewVenues = on.has("newVenue") ? newVenues : [];
    if (firstListing || atNewVenues.length > 0 || newKeys.length > 0) {
      const newVenueSet = new Set(atNewVenues);
      const newKeySet = new Set(newKeys);
      news.push({
        filmId,
        firstListing,
        newVenues: atNewVenues,
        newPerformances: newKeys.length,
        occurrences: firstListing
          ? occurrences
          : occurrences.filter(
              (o) => newVenueSet.has(o.venueId) || newKeySet.has(key(o)),
            ),
      });
    }
    next[filmId] = remembered;
  }

  return { news, memory: next };
}

/**
 * The news about a film added since the last run, from when its showings
 * were first seen against when it was added: listed only after it was added
 * is a first listing; already listed, the venues it reached after are new.
 * Null when there's nothing new, or a showing doesn't say when it was first
 * seen, so it can't be told.
 */
function sinceAddition(
  occurrences: Occurrence[],
  added: number,
  on: ReadonlySet<AlertTrigger>,
): Omit<FilmNews, "filmId"> | null {
  if (occurrences.some(({ seen }) => seen === undefined)) return null;
  const cutoff = added - PUBLISH_LAG_MS;
  const before = occurrences.filter(({ seen }) => seen! <= cutoff);
  const after = occurrences.filter(({ seen }) => seen! > cutoff);
  if (after.length === 0) return null;
  if (before.length === 0) {
    return on.has("firstListing")
      ? { firstListing: true, newVenues: [], newPerformances: 0, occurrences }
      : null;
  }
  if (!on.has("newVenue")) return null;
  const known = new Set(before.map(({ venueId }) => venueId));
  const newVenues = [
    ...new Set(
      after.map(({ venueId }) => venueId).filter((id) => !known.has(id)),
    ),
  ];
  if (newVenues.length === 0) return null;
  const reached = new Set(newVenues);
  return {
    firstListing: false,
    newVenues,
    newPerformances: 0,
    occurrences: occurrences.filter(({ venueId }) => reached.has(venueId)),
  };
}

/**
 * Every watchlist film showing, as if each were first listed: what the email
 * looks like with real listings, for the preview, before any run has built a
 * memory to compare with.
 */
export function everythingShowing(
  data: CinemaData,
  watchlist: ReadonlySet<string>,
  now: number,
): FilmNews[] {
  return [...findOccurrences(data, watchlist, now)]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filmId, occurrences]) => ({
      filmId,
      firstListing: true,
      newVenues: [],
      newPerformances: 0,
      occurrences,
    }));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * The ledger's `films`, as this Worker wrote them. Anything it can't read is
 * dropped, and so forgotten: that film is remembered afresh, never news.
 */
export function readMemory(value: unknown): Memory {
  if (!isRecord(value)) return {};
  const memory: Memory = {};
  for (const [filmId, film] of Object.entries(value)) {
    if (!isRecord(film) || typeof film.showing !== "boolean") continue;
    memory[filmId] = {
      showing: film.showing,
      ...(typeof film.lastShowing === "string" &&
        DATE.test(film.lastShowing) && { lastShowing: film.lastShowing }),
      venues: strings(film.venues),
      ...(Array.isArray(film.performances) && {
        performances: strings(film.performances),
      }),
    };
  }
  return memory;
}

/**
 * When the ledger last remembered the watchlist, for `findNews`'s `since`:
 * the later of its last run and alerts last being switched on.
 */
export function rememberedSince(
  lastRunAt: number | undefined,
  rememberedAt: unknown,
): number | undefined {
  const times = [
    lastRunAt,
    typeof rememberedAt === "number" ? rememberedAt : undefined,
  ].filter((time): time is number => time !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}
