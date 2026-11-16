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
} from "@clusterflick/accounts/firestore";
import { timestampToLondonDateString } from "@clusterflick/catalogue/utils/format-date";
import { renderDigest } from "./digest";
import { getListings } from "./listings";
import { findNews, readMemory, type Memory } from "./news";
import { firestore, readReader, watchlistOf } from "./reader";

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
): Promise<AlertRunOutcome | "alreadyRun"> {
  const { db, env, listings, today, now } = context;
  const reader = await readReader(db, uid);
  const ledgerData = reader.ledger?.data ?? {};
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
    const { ids, titles } = watchlistOf(reader);
    const found = findNews({
      data: listings.data,
      watchlist: ids,
      memory,
      triggers,
      today,
      now,
    });
    // Nothing remembered yet: this run could only remember, and says so,
    // so it isn't mistaken for a quiet night.
    const firstCheck = Object.keys(memory).length === 0 && ids.size > 0;
    memory = found.memory;
    if (found.news.length === 0) {
      run = record(
        AlertRunOutcome.NothingNew,
        firstCheck ? { reason: REASONS.firstCheck } : {},
      );
    } else {
      const digest = renderDigest({
        data: listings.data,
        news: found.news,
        titles,
        siteOrigin: env.SITE_ORIGIN,
        settingsUrl: `${env.SITE_ORIGIN}/personalise/alerts/`,
        now,
      });
      if (isDryRun(env)) {
        run = record(AlertRunOutcome.Previewed, { films: digest.films });
      } else {
        // Sending comes with the next phase; until then, nothing goes.
        throw new Error("Sending isn't built yet: set DRY_RUN");
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
      precondition: reader.ledger
        ? { updateTime: reader.ledger.updateTime }
        : { exists: false },
    },
  ]);
  return run.outcome;
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

  // One at a time: a handful of readers, and each write is checked.
  for (const uid of uids) {
    let outcome: AlertRunOutcome | "alreadyRun";
    try {
      try {
        outcome = await runReader(context, uid);
      } catch (error) {
        // Written by something else since it was read: once more, afresh.
        if (!(error instanceof PreconditionError)) throw error;
        outcome = await runReader(context, uid);
      }
    } catch (error) {
      outcome = AlertRunOutcome.Failed;
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
  }

  await db.commit([{ set: `alertRuns/${today}`, data: { ...night } }]);
  console.log(JSON.stringify({ event: "alerts-night", ...night }));

  if (listings instanceof Error || night[AlertRunOutcome.Failed] > 0) {
    throw new Error(
      `Alerts run for ${today} had failures: ${JSON.stringify(night)}`,
    );
  }
  return night;
}
