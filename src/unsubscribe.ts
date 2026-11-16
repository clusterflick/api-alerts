import {
  alertLedgerPath,
  alertSettingsPath,
  AlertStopReason,
} from "@clusterflick/accounts/alerts";
import { isUid, PreconditionError } from "@clusterflick/accounts/firestore";
import { UpstreamError } from "@clusterflick/accounts/google-auth";
import { firestore } from "./reader";

/**
 * Unsubscribing from an alert email, without signing in. Each email carries
 * a link signed for its reader and its date (HMAC-SHA256 with
 * `UNSUBSCRIBE_SECRET`), which never expires: an unsubscribe link has to
 * keep working.
 *
 * - `POST /unsubscribe?t=…` unsubscribes: a mail client's one-click
 *   (`List-Unsubscribe-Post`), or the button on the page below.
 * - `GET /unsubscribe?t=…`, the email's footer link, shows that button and
 *   changes nothing, since mail scanners follow links.
 *
 * Unsubscribing switches the reader's alerts off and records in their ledger
 * when, and from which email, for the site's panel to say so. Switching them
 * back on is theirs to do, on the site.
 */

export const UNSUBSCRIBE_PATH = "/unsubscribe";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const toBase64Url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function sign(secret: string, payload: string) {
  if (!secret) throw new Error("UNSUBSCRIBE_SECRET isn't set");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
}

/** The token for one reader's email of one date. */
export async function unsubscribeToken(
  secret: string,
  uid: string,
  emailOn: string,
): Promise<string> {
  const payload = `${uid}.${emailOn}`;
  return `${payload}.${await sign(secret, payload)}`;
}

export async function unsubscribeUrl(
  env: Pick<Env, "UNSUBSCRIBE_SECRET">,
  origin: string,
  uid: string,
  emailOn: string,
): Promise<string> {
  const token = await unsubscribeToken(env.UNSUBSCRIBE_SECRET, uid, emailOn);
  return `${origin}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
}

/** The reader and date a token was signed for, or null if it wasn't ours. */
async function readToken(
  secret: string,
  token: string | null,
): Promise<{ uid: string; emailOn: string } | null> {
  const [uid, emailOn, signature, ...rest] = (token ?? "").split(".");
  if (rest.length > 0 || !isUid(uid) || !DATE.test(emailOn ?? "")) {
    return null;
  }
  const expected = await sign(secret, `${uid}.${emailOn}`);
  const encoder = new TextEncoder();
  const [a, b] = [encoder.encode(expected), encoder.encode(signature ?? "")];
  // Equal in constant time, so a wrong signature says nothing of the right one.
  if (a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) {
    return null;
  }
  return { uid, emailOn };
}

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function page(status: number, title: string, body: string) {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Clusterflick</title></head>
<body style="margin:0;padding:48px 16px;background:#111;color:#eee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;">
<main style="max-width:480px;margin:0 auto;">
<h1 style="font-size:24px;margin:0 0 12px;">${escape(title)}</h1>
${body}
</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      },
    },
  );
}

const settingsLink = (env: Env) =>
  `<a href="${escape(env.SITE_ORIGIN)}/personalise/alerts/" style="color:#e4a11b;">your alert settings</a>`;

export async function handleUnsubscribe(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  const reader = await readToken(env.UNSUBSCRIBE_SECRET, token);
  if (!reader) {
    return page(
      400,
      "That link didn't work",
      `<p>It may have been cut short. You can switch your alerts off in ${settingsLink(env)}.</p>`,
    );
  }

  if (request.method === "GET") {
    return page(
      200,
      "Unsubscribe from alerts?",
      `<p>You won't get any more alert emails from Clusterflick. You can switch them back on in ${settingsLink(env)}.</p>
<form method="post" action="${escape(`${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token ?? "")}`)}">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit" style="font:inherit;font-weight:600;padding:10px 20px;border:0;border-radius:8px;background:#e4a11b;color:#111;cursor:pointer;">Unsubscribe</button>
</form>`,
    );
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  }

  const db = firestore(env);
  try {
    await db.commit([
      {
        update: alertSettingsPath(reader.uid),
        data: { enabled: false },
        fields: ["enabled"],
        precondition: { exists: true },
      },
      {
        update: alertLedgerPath(reader.uid),
        data: {
          stopped: {
            reason: AlertStopReason.Unsubscribed,
            at: now,
            emailOn: reader.emailOn,
          },
        },
        fields: ["stopped"],
      },
    ]);
  } catch (error) {
    // No settings: the account's gone, and there's nothing to stop.
    if (!(error instanceof PreconditionError)) {
      console.error(
        JSON.stringify({
          event: "unsubscribe-failed",
          uid: reader.uid,
          message: String(error),
        }),
      );
      if (error instanceof UpstreamError) {
        return page(
          503,
          "That didn't work just now",
          `<p>Please try again in a minute, or switch your alerts off in ${settingsLink(env)}.</p>`,
        );
      }
      throw error;
    }
  }
  console.log(
    JSON.stringify({
      event: "alerts-unsubscribed",
      uid: reader.uid,
      emailOn: reader.emailOn,
    }),
  );
  return page(
    200,
    "You're unsubscribed",
    `<p>You won't get any more alert emails. You can switch them back on in ${settingsLink(env)}.</p>`,
  );
}
