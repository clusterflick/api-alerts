import {
  AuthError,
  FIREBASE_JWKS,
  getBearerToken,
  verifyFirebaseToken,
} from "@clusterflick/accounts/auth";
import type { JWTVerifyGetKey } from "jose";

/**
 * What the site's pages ask of this Worker (`/preview`, `/remember`): a POST
 * from the site's origin (CORS), signed in with the reader's Firebase ID
 * token, and limited per reader. Either the reader's uid, or the response
 * that refuses them.
 */

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

export type Reply = (status: number, body?: unknown) => Response;

/** A response with the request's CORS headers, never cached. */
export function replyTo(env: Env, request: Request): Reply {
  const headers = { ...cors(env, request), "Cache-Control": "no-store" };
  return (status, body) =>
    body === undefined
      ? new Response(null, { status, headers })
      : Response.json(body, { status, headers });
}

/**
 * The signed-in reader's uid, or the response to send instead: the preflight
 * answered, anything but a POST refused, a missing or bad token refused, a
 * reader over the limit told so. Shares one limit across the endpoints.
 */
export async function signedInReader(
  request: Request,
  env: Env,
  reply: Reply,
): Promise<{ uid: string } | { response: Response }> {
  if (request.method === "OPTIONS") return { response: reply(204) };
  if (request.method !== "POST") {
    return { response: reply(405, { error: "method" }) };
  }
  let uid: string;
  try {
    const token = getBearerToken(request);
    if (!token) throw new AuthError("Missing token", 401);
    uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID, keys);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return { response: reply(error.status, { error: error.message }) };
  }
  const { success } = await env.READER_LIMIT.limit({ key: uid });
  if (!success) return { response: reply(429, { error: "rate_limited" }) };
  return { uid };
}
