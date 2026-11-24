import {
  alertLedgerPath,
  alertSettingsPath,
  parseAlertSettings,
  readAlertEmail,
  AlertVenueScope,
  type AlertSettings,
} from "@clusterflick/accounts/alerts";
import {
  CapabilityId,
  hasCapability,
} from "@clusterflick/accounts/capabilities";
import {
  Firestore,
  type VersionedDocument,
} from "@clusterflick/accounts/firestore";
import { getAccessToken } from "@clusterflick/accounts/google-auth";
import {
  readFavouriteVenues,
  readList,
  type List,
} from "@clusterflick/accounts/lists";

/**
 * A reader as a run or a preview needs them: their alert settings, the
 * address alerts go to, whether they still have the capability, their
 * watchlist and favourite venues, and the ledger with the time it was written, for the run to
 * write it back only if nothing else has. Every read throws `UpstreamError`
 * when Firestore can't be asked.
 */

export type Reader = {
  uid: string;
  settings: AlertSettings | null;
  email: string | null;
  granted: boolean;
  watchlist: List;
  /** The ids of their favourite venues. */
  favouriteVenues: ReadonlySet<string>;
  ledger: VersionedDocument | null;
};

export const firestore = (
  env: Pick<Env, "FIREBASE_PROJECT_ID" | "FIREBASE_SERVICE_ACCOUNT">,
) =>
  new Firestore(env.FIREBASE_PROJECT_ID, () =>
    getAccessToken(env.FIREBASE_SERVICE_ACCOUNT),
  );

export async function readReader(db: Firestore, uid: string): Promise<Reader> {
  const [settingsData, granted, [user], ledger] = await Promise.all([
    db.get(alertSettingsPath(uid)),
    hasCapability(db, uid, CapabilityId.EmailAlerts),
    db.batchGet([`users/${uid}`], ["watchlist", "favouriteVenues"]),
    db.getVersioned(alertLedgerPath(uid)),
  ]);
  return {
    uid,
    settings: parseAlertSettings(settingsData),
    email: readAlertEmail(settingsData),
    granted,
    watchlist: readList(user?.watchlist),
    favouriteVenues: new Set(
      Object.keys(readFavouriteVenues(user?.favouriteVenues)),
    ),
    ledger,
  };
}

/**
 * Where a new venue is news for the reader's watchlist alert: anywhere
 * (undefined), or only at their favourite venues.
 */
export function newVenuesOnlyAt(
  reader: Pick<Reader, "favouriteVenues">,
  scope: AlertVenueScope | undefined,
): ReadonlySet<string> | undefined {
  return scope === AlertVenueScope.Favourites
    ? reader.favouriteVenues
    : undefined;
}

/** The watchlist's ids, the titles it was saved with, and when each was added. */
export function watchlistOf(reader: Pick<Reader, "watchlist">) {
  return {
    ids: new Set(Object.keys(reader.watchlist)),
    titles: Object.fromEntries(
      Object.entries(reader.watchlist).map(([id, { title }]) => [id, title]),
    ),
    /** When each was added; an entry saved without a time reads as 0. */
    addedAt: Object.fromEntries(
      Object.entries(reader.watchlist).map(([id, { addedAt }]) => [
        id,
        addedAt,
      ]),
    ),
  };
}
