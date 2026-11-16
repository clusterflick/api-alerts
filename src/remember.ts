import { alertLedgerPath } from "@clusterflick/accounts/alerts";
import { PreconditionError } from "@clusterflick/accounts/firestore";
import { UpstreamError } from "@clusterflick/accounts/google-auth";
import { ListingsUnavailableError } from "@clusterflick/catalogue/utils/fetch-listings";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";
import { getListings } from "./listings";
import { findNews } from "./news";
import { firestore, readReader, watchlistOf } from "./reader";
import { replyTo, signedInReader } from "./site-request";

/**
 * `POST /remember`: the site asks this when a reader switches their alerts
 * on, so their news starts from that moment rather than from the first
 * night's run, which would otherwise only remember the watchlist and find
 * nothing. Every film on it is remembered as it stands now, just as a first
 * run would remember it, and no run is recorded: that night's run then
 * compares against now.
 *
 * Every switch-on, not just the first: someone turning alerts back on after
 * a month off wants news from now, not a month of it at once. Only while
 * they're on, and behind the capability, as the alerts are.
 */

export const REMEMBER_PATH = "/remember";

export async function handleRemember(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const reply = replyTo(env, request);
  const signedIn = await signedInReader(request, env, reply);
  if ("response" in signedIn) return signedIn.response;
  const { uid } = signedIn;

  try {
    const db = firestore(env);
    const { data } = await getListings(env.SITE_ORIGIN, now);
    // Once more if the ledger was written in between (a run, say).
    for (let attempt = 0; ; attempt++) {
      const reader = await readReader(db, uid);
      if (!reader.granted) return reply(403, { error: "not_granted" });
      const triggers =
        reader.settings?.alerts.find(({ type }) => type === "watchlist")
          ?.notify ?? [];
      if (!reader.settings?.enabled || triggers.length === 0) {
        return reply(409, { error: "not_enabled" });
      }
      const { memory } = findNews({
        data,
        watchlist: watchlistOf(reader).ids,
        memory: {},
        triggers,
        today: timestampToLondonDateString(now),
        now,
      });
      try {
        await db.commit([
          {
            set: alertLedgerPath(uid),
            data: {
              ...(reader.ledger?.data ?? {}),
              films: memory,
              rememberedAt: now,
            },
            precondition: reader.ledger
              ? { updateTime: reader.ledger.updateTime }
              : { exists: false },
          },
        ]);
      } catch (error) {
        if (error instanceof PreconditionError && attempt === 0) continue;
        throw error;
      }
      const films = Object.keys(memory).length;
      console.log(JSON.stringify({ event: "alerts-remembered", uid, films }));
      return reply(200, { films });
    }
  } catch (error) {
    if (
      error instanceof UpstreamError ||
      error instanceof ListingsUnavailableError
    ) {
      console.error(
        JSON.stringify({
          event: "remember-unavailable",
          uid,
          message: String(error),
        }),
      );
      return reply(503, { error: "unavailable" });
    }
    throw error;
  }
}
