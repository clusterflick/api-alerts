import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmailEvent, handleEmailEvents } from "../src/events";
import { NOW } from "./fixtures";
import {
  fakeEmail,
  logged,
  reader,
  resetWorker,
  serve,
  type Store,
} from "./helpers";

let log: ReturnType<typeof resetWorker>["log"];

beforeEach(() => {
  ({ log } = resetWorker());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const AT = "2026-11-17T20:00:05.000Z";

/** An event as Email Service publishes one. */
function event(kind: string, payload: Record<string, unknown> = {}) {
  return {
    type: `cf.email.sending.message.${kind}`,
    source: {
      type: "email.sending",
      zoneId: "zone",
      domain: "alerts.clusterflick.com",
    },
    payload: {
      eventId: "e1",
      messageId: "message-1",
      sender: "alert@alerts.clusterflick.com",
      recipient: "u1@example.com",
      terminal: true,
      ...payload,
    },
    metadata: { eventTimestamp: AT },
  };
}

const HARD = {
  bounce: {
    type: "hard",
    classification: "permanent_failure",
    reason: "No such user",
  },
};

function handle(body: unknown, refuse?: string) {
  const email = fakeEmail(refuse);
  return {
    email,
    done: handleEmailEvent({ ...env, EMAIL: email.binding }, body, NOW),
  };
}

const settings = (store: Store) =>
  store["users/u1/meta/alerts"] as { enabled: boolean };
const stopped = (store: Store) =>
  (store["users/u1/meta/alert-ledger"] as { stopped?: unknown } | undefined)
    ?.stopped;

describe("a hard bounce", () => {
  it("switches that reader's alerts off, says why, and tells us", async () => {
    const store = reader("u1", { m1: "Halloween" });
    serve({ movies: () => [], store });
    const { email, done } = handle(event("bounced", HARD));
    await done;
    expect(settings(store).enabled).toBe(false);
    expect(stopped(store)).toEqual({
      reason: "bounced",
      at: Date.parse(AT),
      emailOn: "2026-11-17",
    });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      to: "hello@clusterflick.com",
      subject: "Alerts: bounced for u1@example.com",
    });
    expect(email.sent[0].text).toContain(
      "Bounce: hard (permanent_failure): No such user",
    );
    expect(email.sent[0].text).toContain("Their alerts have been switched off");
  });
});

describe("a spam complaint", () => {
  it("switches that reader's alerts off, and says why", async () => {
    const store = reader("u1", {});
    serve({ movies: () => [], store });
    await handle(event("complained", { complaint: { type: "abuse" } })).done;
    expect(settings(store).enabled).toBe(false);
    expect(stopped(store)).toMatchObject({ reason: "complained" });
  });
});

describe("what isn't the reader asking to stop", () => {
  it.each([
    [
      "a soft bounce",
      "bounced",
      { bounce: { type: "soft", reason: "Mailbox full" } },
    ],
    [
      "a rejected send",
      "rejected",
      { rejection: { reason: "suppressed", party: "cloudflare" } },
    ],
    ["a failed send", "failed", { failure: { reason: "internal" } }],
  ])("%s only tells us", async (_, kind, payload) => {
    const store = reader("u1", {});
    serve({ movies: () => [], store });
    const { email, done } = handle(event(kind, payload));
    await done;
    expect(settings(store).enabled).toBe(true);
    expect(stopped(store)).toBeUndefined();
    expect(email.sent[0].text).toContain("Nothing was switched off.");
  });

  it("a delivery is ignored", async () => {
    const store = reader("u1", {});
    serve({ movies: () => [], store });
    const { email, done } = handle(event("delivered"));
    await done;
    expect(email.sent).toEqual([]);
  });
});

describe("an event", () => {
  it("about an address no reader has still tells us", async () => {
    serve({ movies: () => [], store: {} });
    const { email, done } = handle(event("bounced", HARD));
    await done;
    expect(email.sent[0].text).toContain(
      "no reader has alerts going to this address",
    );
  });

  it("about the address we tell is only logged, so a bounce can't loop", async () => {
    serve({ movies: () => [], store: {} });
    const { email, done } = handle(
      event("bounced", { ...HARD, recipient: "hello@clusterflick.com" }),
    );
    await done;
    expect(email.sent).toEqual([]);
    expect(logged(log, "alerts-email-event")).toHaveLength(1);
  });

  it("that can't be read is logged, not retried forever", async () => {
    serve({ movies: () => [], store: {} });
    const error = vi.spyOn(console, "error");
    await handle({ nonsense: true }).done;
    expect(error).toHaveBeenCalled();
  });
});

describe("the queue", () => {
  function batch(...bodies: unknown[]) {
    const messages = bodies.map((body) => ({
      body,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    return {
      batch: { messages } as unknown as MessageBatch<unknown>,
      messages,
    };
  }

  it("acknowledges what it handled", async () => {
    serve({ movies: () => [], store: reader("u1", {}) });
    const { batch: sent, messages } = batch(event("bounced", HARD));
    await handleEmailEvents(sent, { ...env, EMAIL: fakeEmail().binding });
    expect(messages[0].ack).toHaveBeenCalled();
    expect(messages[0].retry).not.toHaveBeenCalled();
  });

  it("retries what it couldn't, when Firestore is down", async () => {
    serve({ movies: () => [], store: {}, firestoreStatus: 503 });
    const { batch: sent, messages } = batch(event("bounced", HARD));
    await handleEmailEvents(sent, { ...env, EMAIL: fakeEmail().binding });
    expect(messages[0].retry).toHaveBeenCalled();
    expect(messages[0].ack).not.toHaveBeenCalled();
  });
});
