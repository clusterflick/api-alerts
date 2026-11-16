import {
  fetchCurrentRelease,
  fetchRelease,
} from "@clusterflick/catalogue/utils/fetch-listings";
import type { CinemaData } from "@clusterflick/catalogue/types";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";

/**
 * The listings as the site publishes them, held in the isolate between a
 * run's readers and a reader's previews. Unlike api-mcp, which carries on
 * with the last good copy, a failed check throws: an email worked out from
 * yesterday's listings would say nothing's new when it isn't, so a run that
 * can't read today's fails, loudly, and says so in each reader's ledger.
 */

type Held = { meta: string; data: CinemaData; readOn: string };

let held: Held | undefined;

/** For the tests: forget what's held, as a new isolate would. */
export function clearListings() {
  held = undefined;
}

/**
 * The current release, read again when the site has published a new one, or
 * on a new day, since past days are dropped on reading. Throws
 * `ListingsUnavailableError` when they can't be read.
 */
export async function getListings(
  origin: string,
  now = Date.now(),
): Promise<Held> {
  const meta = await fetchCurrentRelease(origin);
  const today = timestampToLondonDateString(now);
  if (held?.meta === meta && held.readOn === today) return held;
  const started = Date.now();
  const data = await fetchRelease(origin, meta);
  held = { meta, data, readOn: today };
  console.log(
    JSON.stringify({
      event: "listings-loaded",
      meta,
      films: Object.keys(data.movies).length,
      ms: Date.now() - started,
    }),
  );
  return held;
}
