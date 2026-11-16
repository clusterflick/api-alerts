import {
  alertLedgerPath,
  alertSettingsPath,
  AlertStopReason,
} from "@clusterflick/accounts/alerts";
import { isUid } from "@clusterflick/accounts/firestore";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";
import { firestore } from "./reader";
import { FROM } from "./send";

/**
 * What Email Service says happened to the emails it sent (an event
 * subscription on alerts.clusterflick.com's sending, into the `alert-events`
 * queue): `cf.email.sending.message.*`, each `{ type, source, payload,
 * metadata }`.
 *
 * - A hard bounce or a spam complaint switches that reader's alerts off,
 *   says why in their ledger for the site's panel, and tells `REPLY_TO`.
 * - A soft bounce whose retries ran out, a rejected or a failed send only
 *   tells `REPLY_TO`: a full mailbox or our own mistake isn't the reader
 *   asking to stop.
 * - Anything else (delivered, deferred) is ignored.
 *
 * Email Service suppresses bounced and complaining addresses itself as well;
 * this is so the reader and we both know. The reader is found by the address,
 * which their alert settings hold.
 */

const PREFIX = "cf.email.sending.message.";

export type EmailEvent = {
  type: string;
  payload: {
    messageId?: string;
    recipient?: string;
    subject?: string;
    bounce?: { type?: string; classification?: string; reason?: string };
    complaint?: { type?: string };
    rejection?: { reason?: string; party?: string; detail?: string };
    failure?: { reason?: string };
    delivery?: { smtpStatusCode?: string; smtpResponse?: string };
  };
  metadata?: { eventTimestamp?: string };
};

const isEvent = (value: unknown): value is EmailEvent =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as EmailEvent).type === "string" &&
  typeof (value as EmailEvent).payload === "object" &&
  (value as EmailEvent).payload !== null;

/** What the event means for the reader: stop their alerts, or only tell us. */
function classify(event: EmailEvent): {
  stop?: AlertStopReason;
  tell: boolean;
} {
  switch (event.type.slice(PREFIX.length)) {
    case "complained":
      return { stop: AlertStopReason.Complained, tell: true };
    case "bounced":
      return event.payload.bounce?.type === "hard"
        ? { stop: AlertStopReason.Bounced, tell: true }
        : { tell: true };
    case "rejected":
    case "failed":
      return { tell: true };
    default:
      return { tell: false };
  }
}

/** The readers whose alerts go to `address`: one, almost always. */
async function readersAt(env: Env, address: string): Promise<string[]> {
  const found = await firestore(env).findInCollectionGroup(
    "meta",
    "email",
    address,
  );
  return found.flatMap(({ path }) => {
    const uid = path.match(/^users\/([^/]+)\/meta\/alerts$/)?.[1];
    return uid && isUid(uid) ? [uid] : [];
  });
}

/** Handles one event. Throws to have it retried: Firestore or sending failed. */
export async function handleEmailEvent(
  env: Env,
  body: unknown,
  now = Date.now(),
): Promise<void> {
  if (!isEvent(body) || !body.type.startsWith(PREFIX)) {
    console.error(
      JSON.stringify({ event: "alerts-event-unreadable", body: String(body) }),
    );
    return;
  }
  const { stop, tell } = classify(body);
  if (!tell) return;

  const { recipient } = body.payload;
  const at = Date.parse(body.metadata?.eventTimestamp ?? "") || now;
  const uids = recipient ? await readersAt(env, recipient) : [];

  if (stop) {
    const db = firestore(env);
    for (const uid of uids) {
      await db.commit([
        {
          update: alertSettingsPath(uid),
          data: { enabled: false },
          fields: ["enabled"],
          precondition: { exists: true },
        },
        {
          update: alertLedgerPath(uid),
          data: {
            stopped: {
              reason: stop,
              at,
              emailOn: timestampToLondonDateString(at),
            },
          },
          fields: ["stopped"],
        },
      ]);
    }
  }

  console.log(
    JSON.stringify({
      event: "alerts-email-event",
      type: body.type,
      messageId: body.payload.messageId ?? null,
      uids,
      stopped: Boolean(stop && uids.length > 0),
    }),
  );

  // Never about the address we'd be telling: a bounce of the notice itself
  // would only ever make another.
  if (!recipient || recipient === env.REPLY_TO) return;
  const lines = [
    `Email Service: ${body.type.slice(PREFIX.length)}`,
    `To: ${recipient}`,
    `Reader: ${uids.join(", ") || "no reader has alerts going to this address"}`,
    ...(body.payload.subject ? [`Subject: ${body.payload.subject}`] : []),
    ...(body.payload.bounce
      ? [
          `Bounce: ${body.payload.bounce.type ?? "?"} (${body.payload.bounce.classification ?? "?"}): ${body.payload.bounce.reason ?? ""}`,
        ]
      : []),
    ...(body.payload.complaint
      ? [`Complaint: ${body.payload.complaint.type ?? "?"}`]
      : []),
    ...(body.payload.rejection
      ? [
          `Rejected by ${body.payload.rejection.party ?? "?"}: ${body.payload.rejection.reason ?? ""} ${body.payload.rejection.detail ?? ""}`,
        ]
      : []),
    ...(body.payload.failure
      ? [`Failed: ${body.payload.failure.reason ?? ""}`]
      : []),
    ...(body.payload.delivery?.smtpResponse
      ? [
          `SMTP: ${body.payload.delivery.smtpStatusCode ?? ""} ${body.payload.delivery.smtpResponse}`,
        ]
      : []),
    `Message: ${body.payload.messageId ?? "?"}`,
    "",
    stop && uids.length > 0
      ? "Their alerts have been switched off, and their panel says why."
      : "Nothing was switched off.",
  ];
  await env.EMAIL.send({
    from: FROM,
    to: env.REPLY_TO,
    subject: `Alerts: ${body.type.slice(PREFIX.length)} for ${recipient}`,
    text: lines.join("\n"),
  });
}

/** The queue's batch: each event acknowledged once handled, else retried. */
export async function handleEmailEvents(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleEmailEvent(env, message.body);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "alerts-event-failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      message.retry();
    }
  }
}
