import type { CinemaData, Movie } from "@clusterflick/catalogue/types";
import {
  addLondonDays,
  dateStringToLondonTimestamp,
} from "@clusterflick/catalogue/utils/format-date";

/** The run's day in these tests: a Monday in November, GMT. */
export const TODAY = "2026-11-16";
const MIDNIGHT = dateStringToLondonTimestamp(TODAY);
const HOUR = 3_600_000;
/** 20:00 on TODAY, when the run goes. */
export const NOW = MIDNIGHT + 20 * HOUR;

/** `hours` into the London day `days` from TODAY. */
export const at = (days: number, hours: number) =>
  addLondonDays(MIDNIGHT, days) + hours * HOUR;

/** The London date `days` from TODAY. */
export const dayFrom = (days: number) =>
  new Date(addLondonDays(MIDNIGHT, days) + 12 * HOUR)
    .toISOString()
    .slice(0, 10);

type Performances = Record<string, number[]>;

/**
 * A film listed at venues, each with its performance times: `{ rio: [t1] }`.
 * One showing per venue.
 */
export function film(
  id: string,
  title: string,
  at: Performances,
  extra: Partial<Movie> = {},
): Movie {
  const showings: Movie["showings"] = {};
  const performances: Movie["performances"] = [];
  for (const [venueId, times] of Object.entries(at)) {
    const showingId = `${id}-${venueId}`;
    showings[showingId] = {
      id: showingId,
      category: "movie" as Movie["showings"][string]["category"],
      url: `https://${venueId}.example/${id}`,
      venueId,
    };
    for (const time of times) {
      performances.push({
        showingId,
        time,
        bookingUrl: `https://${venueId}.example/book/${id}/${time}`,
      });
    }
  }
  return {
    id,
    title,
    normalizedTitle: title.toLowerCase(),
    showings,
    performances,
    ...extra,
  };
}

export const VENUES: Record<string, string> = {
  rio: "Rio Cinema",
  pcc: "Prince Charles Cinema",
  bfi: "BFI Southbank",
  ica: "ICA",
  barbican: "Barbican Cinema",
};

/** Listings holding these films, read as the site reads them. */
export function listings(...movies: Movie[]): CinemaData {
  return {
    filenames: [],
    generatedAt: "2026-11-16T06:00:00Z",
    venues: Object.fromEntries(
      Object.entries(VENUES).map(([id, name]) => [id, { id, name }]),
    ) as unknown as CinemaData["venues"],
    people: {},
    genres: {},
    collections: {},
    movies: Object.fromEntries(movies.map((movie) => [movie.id, movie])),
  } as CinemaData;
}
