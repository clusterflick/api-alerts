import {
  parseAlertLedger,
  parseAlertSettings,
} from "@clusterflick/accounts/alerts";
import {
  AuthError,
  FIREBASE_JWKS,
  getBearerToken,
  verifyFirebaseToken,
} from "@clusterflick/accounts/auth";
import { UpstreamError } from "@clusterflick/accounts/google-auth";
import { ListingsUnavailableError } from "@clusterflick/catalogue/utils/fetch-listings";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";
import type { JWTVerifyGetKey } from "jose";
import { renderDigest } from "./digest";
import { getListings } from "./listings";
import { everythingShowing, findNews, readMemory } from "./news";
import { firestore, readReader, watchlistOf } from "./reader";

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

let keys: JWTVerifyGetKey = FIREBASE_JWKS;

/** For the tests: Firebase's signing keys, as a local key set. */
export function useFirebaseKeys(local: JWTVerifyGetKey) {
  keys = local;
}

function cors(env: Env, request: Request): Record<string, string> {
  return request.headers.get("Origin") === env.SITE_ORIGIN
    ? {
        "Access-Control-Allow-Origin": env.SITE_ORIGIN,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
    : { Vary: "Origin" };
}

export async function handlePreview(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const headers = { ...cors(env, request), "Cache-Control": "no-store" };
  const reply = (status: number, body?: unknown) =>
    body === undefined
      ? new Response(null, { status, headers })
      : Response.json(body, { status, headers });

  if (request.method === "OPTIONS") return reply(204);
  if (request.method !== "POST") return reply(405, { error: "method" });

  let uid: string;
  try {
    const token = getBearerToken(request);
    if (!token) throw new AuthError("Missing token", 401);
    uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID, keys);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return reply(error.status, { error: error.message });
  }

  const { success } = await env.PREVIEW_LIMIT.limit({ key: uid });
  if (!success) return reply(429, { error: "rate_limited" });

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
    const { ids, titles } = watchlistOf(reader);
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
