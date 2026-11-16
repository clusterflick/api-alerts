import {
  alertLedgerPath,
  AlertRunOutcome,
  MAX_ALERT_RUNS,
  parseAlertLedger,
  type AlertRun,
} from "@clusterflick/accounts/alerts";
import {
  isUid,
  PreconditionError,
  type Firestore,
  type Precondition,
} from "@clusterflick/accounts/firestore";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";
import { renderDigest } from "./digest";
import { getListings } from "./listings";
import { findNews, readMemory, rememberedSince, type Memory } from "./news";
import { firestore, readReader, watchlistOf } from "./reader";
import { FROM, sendDigest } from "./send";
import { unsubscribeUrl } from "./unsubscribe";

/**
 * The nightly run: every reader with alerts switched on, their watchlist
 * against tonight's listings, and their ledger brought up to date: what each
 * film was seen doing, and how the run went for them, newest first. While
 * `DRY_RUN` is on, each email is worked out and recorded as one that would
 * have gone, and none is sent.
 *
 * A reader's run is written once a night: a second run the same night (a
 * retry, a duplicate trigger) finds tonight's entry and leaves them be. Every
 * failure is recorded in the reader's ledger, which their panel shows, and in
 * the night's record, and fails the run as a whole so it shows in the logs.
 */

/**
 * Whether the run sends nothing: anything but "false", so a missing or
 * mistyped setting never sends.
 */
export const isDryRun = (env: Pick<Env, "DRY_RUN">) =>
  String(env.DRY_RUN) !== "false";

/** What the reader is told went wrong, in their panel. */
export const REASONS = {
  off: "alerts were switched off",
  notGranted: "email alerts aren't switched on for your account",
  noAddress: "we don't know where to send them: save your alert settings again",
  noListings: "the listings couldn't be read",
  unreadable: "your alerts couldn't be read",
  /**
   * For "nothing new", when there was nothing to compare with: alerts
   * switched on without the watchlist remembered, so this run did it.
   */
  firstCheck:
    "the first check, which noted your watchlist as it stands; news starts from the next",
  sendFailed: "the email couldn't be sent",
  notResent:
    "we can't tell whether that night's email went, so it wasn't sent again",
} as const;

/** The night's record, `alertRuns/{date}`: only this Worker reads it. */
export type NightRecord = {
  on: string;
  at: number;
  /** The release the run read, when it could. */
  release: string | null;
  dryRun: boolean;
  readers: number;
} & Record<AlertRunOutcome | "alreadyRun", number>;

const ALERTS_PATH = /^users\/([^/]+)\/meta\/alerts$/;

type Listings = Awaited<ReturnType<typeof getListings>>;

type Context = {
  db: Firestore;
  env: Env;
  listings: Listings | Error;
  today: string;
  now: number;
};

/**
 * One reader's run, written to their ledger only if nothing else has written
 * it since it was read. "alreadyRun" when tonight's is there already.
 */
async function runReader(
  context: Context,
  uid: string,
): Promise<AlertRun | "alreadyRun"> {
  const { db, env, listings, today, now } = context;
  const reader = await readReader(db, uid);
  // Without the claim: it's for one night's run alone.
  const { sending, ...ledgerData } = reader.ledger?.data ?? {};
  // The precondition the ledger's write needs, moved on by a claim.
  let precondition: Precondition = reader.ledger
    ? { updateTime: reader.ledger.updateTime }
    : { exists: false };
  const { runs } = parseAlertLedger(ledgerData);
  if (runs.some((run) => run.on === today)) return "alreadyRun";

  let memory: Memory = readMemory(ledgerData.films);
  let run: AlertRun;
  const record = (
    outcome: AlertRunOutcome,
    extra: Partial<AlertRun> = {},
  ): AlertRun => ({ on: today, at: now, outcome, ...extra });

  const triggers =
    reader.settings?.alerts.find(({ type }) => type === "watchlist")?.notify ??
    [];
  if (!reader.settings?.enabled || triggers.length === 0) {
    run = record(AlertRunOutcome.Skipped, { reason: REASONS.off });
  } else if (!reader.granted) {
    run = record(AlertRunOutcome.Skipped, { reason: REASONS.notGranted });
  } else if (!reader.email) {
    run = record(AlertRunOutcome.Failed, { reason: REASONS.noAddress });
  } else if (listings instanceof Error) {
    run = record(AlertRunOutcome.Failed, { reason: REASONS.noListings });
  } else {
    const { ids, titles, addedAt } = watchlistOf(reader);
    const found = findNews({
      data: listings.data,
      watchlist: ids,
      memory,
      triggers,
      today,
      now,
      addedAt,
      since: rememberedSince(runs[0]?.at, ledgerData.rememberedAt),
    });
    // Nothing remembered yet: this run could only remember, and says so,
    // so it isn't mistaken for a quiet night.
    const firstCheck = Object.keys(memory).length === 0 && ids.size > 0;
    const remembered = memory;
    memory = found.memory;
    if (found.news.length === 0) {
      run = record(
        AlertRunOutcome.NothingNew,
        firstCheck ? { reason: REASONS.firstCheck } : {},
      );
    } else {
      const unsubscribe = isDryRun(env)
        ? undefined
        : await unsubscribeUrl(env, env.ALERTS_ORIGIN, uid, today);
      const digest = renderDigest({
        data: listings.data,
        news: found.news,
        titles,
        siteOrigin: env.SITE_ORIGIN,
        settingsUrl: `${env.SITE_ORIGIN}/personalise/alerts/`,
        unsubscribeUrl: unsubscribe,
        now,
      });
      if (isDryRun(env)) {
        run = record(AlertRunOutcome.Previewed, { films: digest.films });
      } else if (sending === today) {
        // A run that claimed tonight's email and stopped before recording
        // it: it may have gone. Never twice, so this run doesn't send, and
        // remembers as if it went.
        run = record(AlertRunOutcome.NotResent, { reason: REASONS.notResent });
        console.error(JSON.stringify({ event: "alerts-not-resent", uid }));
      } else {
        // Claimed before sending, so only one run can send tonight's.
        await db.commit([
          {
            set: alertLedgerPath(uid),
            data: { ...ledgerData, sending: today },
            precondition,
          },
        ]);
        const claimed = await db.getVersioned(alertLedgerPath(uid));
        if (!claimed) throw new Error(`The claim on ${uid}'s ledger is gone`);
        precondition = { updateTime: claimed.updateTime };
        try {
          const messageId = await sendDigest(env, reader.email, digest, {
            // One-click, as Gmail and Yahoo ask of a sender (RFC 8058).
            "List-Unsubscribe": `<${unsubscribe}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          });
          run = record(AlertRunOutcome.Sent, { films: digest.films });
          console.log(
            JSON.stringify({
              event: "alerts-sent",
              uid,
              messageId,
              films: digest.films,
            }),
          );
        } catch (error) {
          // Refused, so nothing went: the news stays news for tomorrow.
          memory = remembered;
          run = record(AlertRunOutcome.Failed, { reason: REASONS.sendFailed });
          console.error(
            JSON.stringify({
              event: "alerts-send-failed",
              uid,
              code: (error as { code?: unknown })?.code ?? null,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }
  }

  await db.commit([
    {
      set: alertLedgerPath(uid),
      data: {
        ...ledgerData,
        films: memory,
        runs: [run, ...runs].slice(0, MAX_ALERT_RUNS),
      },
      precondition,
    },
  ]);
  return run;
}

/**
 * A run that can't read the reader's documents at all still says so in
 * their ledger, if it can write it, so the panel doesn't go quiet.
 */
async function recordFailure(db: Firestore, uid: string, run: AlertRun) {
  try {
    const ledger = await db.getVersioned(alertLedgerPath(uid));
    const { runs } = parseAlertLedger(ledger?.data);
    if (runs.some(({ on }) => on === run.on)) return;
    await db.commit([
      {
        set: alertLedgerPath(uid),
        data: {
          ...(ledger?.data ?? {}),
          runs: [run, ...runs].slice(0, MAX_ALERT_RUNS),
        },
        precondition: ledger
          ? { updateTime: ledger.updateTime }
          : { exists: false },
      },
    ]);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "alerts-record-failed",
        uid,
        message: String(error),
      }),
    );
  }
}

export async function runNightly(env: Env, now = Date.now()) {
  const db = firestore(env);
  const today = timestampToLondonDateString(now);
  const listings = await getListings(env.SITE_ORIGIN, now).catch(
    (error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
  );
  if (listings instanceof Error) {
    console.error(
      JSON.stringify({
        event: "alerts-no-listings",
        message: listings.message,
      }),
    );
  }

  const enabled = await db.findInCollectionGroup("meta", "enabled", true);
  const uids = enabled.flatMap(({ path }) => {
    const uid = path.match(ALERTS_PATH)?.[1];
    return uid && isUid(uid) ? [uid] : [];
  });

  const night: NightRecord = {
    on: today,
    at: now,
    release: listings instanceof Error ? null : listings.meta,
    dryRun: isDryRun(env),
    readers: uids.length,
    alreadyRun: 0,
    ...(Object.fromEntries(
      Object.values(AlertRunOutcome).map((outcome) => [outcome, 0]),
    ) as Record<AlertRunOutcome, number>),
  };
  const context: Context = { db, env, listings, today, now };

  // What went wrong for whom, for the night's notice.
  const problems: { uid: string; outcome: string; reason: string }[] = [];

  // One at a time: a handful of readers, and each write is checked.
  for (const uid of uids) {
    let outcome: AlertRunOutcome | "alreadyRun";
    let reason: string | undefined;
    try {
      let run: AlertRun | "alreadyRun";
      try {
        run = await runReader(context, uid);
      } catch (error) {
        // Written by something else since it was read: once more, afresh.
        if (!(error instanceof PreconditionError)) throw error;
        run = await runReader(context, uid);
      }
      outcome = run === "alreadyRun" ? run : run.outcome;
      reason = run === "alreadyRun" ? undefined : run.reason;
    } catch (error) {
      outcome = AlertRunOutcome.Failed;
      reason = `${REASONS.unreadable} (${error instanceof Error ? error.message : String(error)})`;
      console.error(
        JSON.stringify({
          event: "alerts-reader-failed",
          uid,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await recordFailure(db, uid, {
        on: today,
        at: now,
        outcome,
        reason: REASONS.unreadable,
      });
    }
    night[outcome]++;
    console.log(JSON.stringify({ event: "alerts-reader", uid, outcome }));
    if (
      outcome === AlertRunOutcome.Failed ||
      outcome === AlertRunOutcome.NotResent
    ) {
      problems.push({ uid, outcome, reason: reason ?? "" });
    }
  }

  await db.commit([{ set: `alertRuns/${today}`, data: { ...night } }]);
  console.log(JSON.stringify({ event: "alerts-night", ...night }));

  if (listings instanceof Error || problems.length > 0) {
    await tellOfProblems(env, night, listings, problems);
  }
  if (listings instanceof Error || night[AlertRunOutcome.Failed] > 0) {
    throw new Error(
      `Alerts run for ${today} had failures: ${JSON.stringify(night)}`,
    );
  }
  return night;
}

/**
 * A night that went wrong, told to `REPLY_TO`, so it's seen that evening
 * rather than whenever someone next opens the logs or their panel. A notice
 * that can't be sent is logged; the run still fails as it would have.
 */
async function tellOfProblems(
  env: Env,
  night: NightRecord,
  listings: Listings | Error,
  problems: { uid: string; outcome: string; reason: string }[],
) {
  const counts = Object.entries(night)
    .filter(
      ([key, value]) =>
        typeof value === "number" &&
        value > 0 &&
        !["at", "readers"].includes(key),
    )
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  const text = [
    `The alerts run for ${night.on} had problems.`,
    "",
    `Readers: ${night.readers} (${counts || "none checked"})`,
    `Listings: ${listings instanceof Error ? `couldn't be read: ${listings.message}` : night.release}`,
    `Sending: ${night.dryRun ? "off (DRY_RUN)" : "on"}`,
    ...(problems.length > 0
      ? ["", ...problems.map((p) => `${p.uid}: ${p.outcome}, ${p.reason}`)]
      : []),
    "",
    "Each reader's panel says what happened to them. Workers Logs have the rest.",
  ].join("\n");
  try {
    await env.EMAIL.send({
      from: FROM,
      to: env.REPLY_TO,
      subject: `Alerts: problems with the run for ${night.on}`,
      text,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "alerts-problems-notice-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
