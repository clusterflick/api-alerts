import {
  decodeFields,
  encodeFields,
  type Fields,
} from "@clusterflick/accounts/firestore";
import { clearAccessToken } from "@clusterflick/accounts/google-auth";
import type { Movie } from "@clusterflick/catalogue/types";
import { DATA_FORMAT_VERSION } from "@clusterflick/catalogue/data-format.mjs";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { vi } from "vitest";
import worker from "../src/index";
import { clearListings } from "../src/listings";
import { useFirebaseKeys } from "../src/site-request";
import { runNightly } from "../src/run";
import { VENUES } from "./fixtures";

export const SITE = "https://clusterflick.com";
export const ALERTS = "https://alerts.clusterflick.com";
export const PROJECT_ID = "clusterflick-com";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
/**
 * Ten hex digits of a hash of `text`: the site names each published file by
 * its content's hash, so new listings arrive under new names.
 */
function contentHash(text: string) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return (a.toString(16).padStart(8, "0") + b.toString(16)).slice(0, 10);
}

/** Firestore's documents by path, as the fake holds them. */
export type Store = Record<string, Record<string, unknown>>;

/** A reader with the capability and alerts on, and this watchlist. */
export function reader(
  uid: string,
  watchlist: Record<string, string>,
  {
    notify = ["firstListing", "newVenue"],
    enabled = true,
    email = `${uid}@example.com` as string | null,
  } = {},
): Store {
  return {
    [`users/${uid}/meta/capabilities`]: { emailAlerts: { grantedAt: 1 } },
    [`users/${uid}/meta/alerts`]: {
      enabled,
      ...(email && { email }),
      alerts: [{ type: "watchlist", notify }],
    },
    [`users/${uid}`]: {
      watchlist: Object.fromEntries(
        Object.entries(watchlist).map(([id, title]) => [
          id,
          { title, addedAt: 1 },
        ]),
      ),
    },
  };
}

/**
 * The site's published listings holding these films, Google's token
 * endpoint, and Firestore, which keeps every write in `store` with the time
 * it was made, for the Worker's preconditions. `movies` is read on every
 * request, so a test can change the listings between runs.
 */
export function serve(options: {
  movies: () => Movie[];
  store: Store;
  siteStatus?: number;
  firestoreStatus?: number;
}) {
  const { store } = options;
  const updated: Record<string, number> = {};
  let clock = 0;
  const writes: string[] = [];
  const stamp = (path: string) => {
    updated[path] = ++clock;
  };
  for (const path of Object.keys(store)) stamp(path);
  const updateTime = (path: string) =>
    `2026-11-16T00:00:00.${String(updated[path]).padStart(6, "0")}Z`;
  const document = (path: string) => ({
    name: `${ROOT}/${path}`,
    fields: encodeFields(store[path]),
    updateTime: updateTime(path),
  });

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.href === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "google-token",
          expires_in: 3599,
        });
      }

      if (url.hostname === "firestore.googleapis.com") {
        if (options.firestoreStatus) {
          return new Response("unavailable", {
            status: options.firestoreStatus,
          });
        }
        const target = decodeURIComponent(url.pathname).slice(
          `/v1/${ROOT}`.length,
        );
        if (target === ":batchGet") {
          const { documents, mask } = (await request.json()) as {
            documents: string[];
            mask: { fieldPaths: string[] };
          };
          return Response.json(
            documents.map((full) => {
              const path = full.slice(ROOT.length + 1);
              if (!store[path]) return { missing: full };
              const kept = Object.fromEntries(
                Object.entries(store[path]).filter(([k]) =>
                  mask.fieldPaths.includes(k),
                ),
              );
              return {
                found: { ...document(path), fields: encodeFields(kept) },
              };
            }),
          );
        }
        if (target === ":runQuery") {
          const { structuredQuery } = (await request.json()) as {
            structuredQuery: {
              from: [{ collectionId: string }];
              where: {
                fieldFilter: {
                  field: { fieldPath: string };
                  value: Fields[string];
                };
              };
            };
          };
          const { collectionId } = structuredQuery.from[0];
          const { field, value } = structuredQuery.where.fieldFilter;
          const wanted = decodeFields({ v: value }).v;
          const found = Object.keys(store).filter((path) => {
            const parts = path.split("/");
            return (
              parts.at(-2) === collectionId &&
              store[path][field.fieldPath] === wanted
            );
          });
          return Response.json(
            found.length === 0
              ? [{ readTime: "t" }]
              : found.map((path) => ({
                  document: document(path),
                  readTime: "t",
                })),
          );
        }
        if (target === ":commit") {
          const { writes: sent } = (await request.json()) as {
            writes: {
              update?: { name: string; fields: Fields };
              delete?: string;
              currentDocument?: { exists?: boolean; updateTime?: string };
            }[];
          };
          for (const write of sent) {
            const path = (write.update?.name ?? write.delete ?? "").slice(
              ROOT.length + 1,
            );
            const pre = write.currentDocument;
            const failed =
              (pre?.exists === false && store[path]) ||
              (pre?.exists === true && !store[path]) ||
              (pre?.updateTime &&
                (!store[path] || updateTime(path) !== pre.updateTime));
            if (failed) {
              return Response.json(
                { error: { code: 400, status: "FAILED_PRECONDITION" } },
                { status: 400 },
              );
            }
          }
          for (const write of sent) {
            if (write.update) {
              const path = write.update.name.slice(ROOT.length + 1);
              store[path] = decodeFields(write.update.fields);
              stamp(path);
              writes.push(path);
            } else if (write.delete) {
              const path = write.delete.slice(ROOT.length + 1);
              delete store[path];
              writes.push(path);
            }
          }
          return Response.json({ writeResults: [] });
        }
        const path = target.slice(1);
        if (!store[path]) return Response.json({}, { status: 404 });
        return Response.json(document(path));
      }

      if (url.href.startsWith(`${SITE}/data/`)) {
        if (options.siteStatus) {
          return new Response("down", { status: options.siteStatus });
        }
        const name = url.href.slice(`${SITE}/data/`.length);
        const movies = options.movies();
        // Published without ids, which are the keys.
        const chunk = Object.fromEntries(
          movies.map(({ id, ...movie }) => [id, movie]),
        );
        const hash = contentHash(JSON.stringify(chunk));
        const chunkName = `data.0.${hash}.json`;
        const metaName = `data.meta.${hash}.json`;
        const files: Record<string, unknown> = {
          "current.json": {
            formatVersion: DATA_FORMAT_VERSION,
            meta: metaName,
          },
          [metaName]: {
            formatVersion: DATA_FORMAT_VERSION,
            generatedAt: "2026-11-16T06:00:00Z",
            filenames: [chunkName],
            mapping: { "0": movies.map(({ id }) => id) },
            genres: {},
            people: {},
            venues: Object.fromEntries(
              Object.entries(VENUES).map(([id, name]) => [id, { name }]),
            ),
            collections: {},
          },
          [chunkName]: chunk,
        };
        return name in files
          ? Response.json(files[name])
          : new Response("Not found", { status: 404 });
      }
      return new Response("Unexpected request", { status: 500 });
    });
  return { spy, writes };
}

/** Forget what the isolate holds, as a new one would. */
export function resetWorker() {
  clearListings();
  clearAccessToken();
  useFirebaseKeys(FIREBASE_TEST_KEYS);
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

/** The night's run at `scheduledTime`, and the night's record. */
export function runNight(scheduledTime: number, overrides: Partial<Env> = {}) {
  return runNightly({ ...env, ...overrides }, scheduledTime);
}

/**
 * Email Service, faked: every message it was asked to send, refusing them
 * all with `refuse`'s code when it's set. Nothing leaves the test.
 */
export function fakeEmail(refuse?: string) {
  const sent: EmailMessageBuilder[] = [];
  const binding = {
    async send(message: EmailMessageBuilder) {
      if (refuse) {
        throw Object.assign(new Error(`Refused: ${refuse}`), { code: refuse });
      }
      sent.push(message);
      return { messageId: `message-${sent.length}` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

/** The cron calling the Worker, at `scheduledTime`. */
export function runScheduled(scheduledTime: number) {
  const controller = createScheduledController({
    scheduledTime,
    cron: "0 20 * * *",
  });
  return worker.scheduled(controller, env);
}

export async function request(input: string, init?: RequestInit) {
  return worker.fetch(
    new Request(input, init) as unknown as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    env,
  );
}

const firebaseKeys = await generateKeyPair("RS256");
const FIREBASE_TEST_KEYS = createLocalJWKSet({
  keys: [
    {
      ...(await exportJWK(firebaseKeys.publicKey)),
      kid: "firebase-test-key",
      alg: "RS256",
    },
  ],
});

/** An ID token as the site's sign-in makes one, for `uid`. */
export function signIn(uid: string, claims: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: uid,
    iat: now - 60,
    exp: now + 3600,
    auth_time: now - 60,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "firebase-test-key" })
    .sign(firebaseKeys.privateKey);
}

/** What was logged for an event, parsed. */
export const logged = (
  spy: ReturnType<typeof vi.spyOn>,
  event: string,
): Record<string, unknown>[] =>
  (spy.mock.calls as unknown[][])
    .map(([line]): Record<string, unknown> | null => {
      try {
        return JSON.parse(String(line));
      } catch {
        return null;
      }
    })
    .filter(
      (entry): entry is Record<string, unknown> => entry?.event === event,
    );
