import {
  parseAlertLedger,
  parseAlertSettings,
} from "@clusterflick/accounts/alerts";
import { UpstreamError } from "@clusterflick/accounts/google-auth";
import { ListingsUnavailableError } from "@clusterflick/catalogue/utils/fetch-listings";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";
import { renderDigest } from "./digest";
import { getListings } from "./listings";
import {
  everythingShowing,
  findNews,
  readMemory,
  rememberedSince,
} from "./news";
import { firestore, readReader, watchlistOf } from "./reader";
import { replyTo, signedInReader } from "./site-request";

/**
 * `POST /preview`: the email a reader's alerts would send, worked out now and
 * never sent or recorded, for the settings page to show beside the settings
 * being edited. Signed in with their Firebase ID token, from the site's
 * pages only (CORS).
 *
 * - `sinceLastRun`: tonight's email so far, against what their ledger
 *   remembers from the last run. Until a run has remembered their watchlist
 *   there's nothing to compare with, and it says so (`baseline`).
 * - `everythingShowing`: every watchlist film that's showing, as if each
 *   were new, to see the email with real listings before any run.
 *
 * Takes the triggers being edited, not the saved ones, so the preview follows
 * the switches. Behind the capability, as the alerts are.
 */

export const PREVIEW_PATH = "/preview";

const MODES = ["sinceLastRun", "everythingShowing"] as const;
type Mode = (typeof MODES)[number];

export async function handlePreview(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const reply = replyTo(env, request);
  const signedIn = await signedInReader(request, env, reply);
  if ("response" in signedIn) return signedIn.response;
  const { uid } = signedIn;

  let body: { notify?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return reply(400, { error: "Body must be JSON" });
  }
  const mode = MODES.find((each) => each === body?.mode);
  if (!mode) return reply(400, { error: `mode must be ${MODES.join(" or ")}` });
  const triggers =
    parseAlertSettings({
      enabled: true,
      alerts: [{ type: "watchlist", notify: body.notify }],
    })?.alerts[0]?.notify ?? [];

  try {
    const reader = await readReader(firestore(env), uid);
    if (!reader.granted) return reply(403, { error: "not_granted" });
    const { data } = await getListings(env.SITE_ORIGIN, now);
    const { ids, titles, addedAt } = watchlistOf(reader);
    const ledger = parseAlertLedger(reader.ledger?.data);
    const memory = readMemory(reader.ledger?.data.films);
    const baseline =
      mode === "sinceLastRun" && Object.keys(memory).length === 0;
    const news =
      mode === "everythingShowing"
        ? everythingShowing(data, ids, now)
        : baseline || triggers.length === 0
          ? []
          : findNews({
              data,
              watchlist: ids,
              memory,
              triggers,
              today: timestampToLondonDateString(now),
              now,
              addedAt,
              since: rememberedSince(
                ledger.runs[0]?.at,
                reader.ledger?.data.rememberedAt,
              ),
            }).news;
    return reply(200, {
      mode: mode satisfies Mode,
      baseline,
      lastRun: ledger.runs[0]?.on ?? null,
      digest:
        news.length === 0
          ? null
          : renderDigest({
              data,
              news,
              titles,
              siteOrigin: env.SITE_ORIGIN,
              settingsUrl: `${env.SITE_ORIGIN}/personalise/alerts/`,
              now,
            }),
    });
  } catch (error) {
    if (
      error instanceof UpstreamError ||
      error instanceof ListingsUnavailableError
    ) {
      console.error(
        JSON.stringify({
          event: "preview-unavailable",
          message: String(error),
        }),
      );
      return reply(503, { error: "unavailable" });
    }
    throw error;
  }
}
