import type { Movie } from "@clusterflick/catalogue/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASONS } from "../src/run";
import { at, dayFrom, film, NOW, TODAY } from "./fixtures";
import {
  fakeEmail,
  logged,
  reader,
  resetWorker,
  runNight,
  serve,
  type Store,
} from "./helpers";

let log: ReturnType<typeof resetWorker>["log"];

/** 20:00 the next day. */
const NEXT_NIGHT = NOW + 24 * 3_600_000;

beforeEach(() => {
  ({ log } = resetWorker());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Ledger = {
  runs: Record<string, unknown>[];
  films: Record<string, { venues: string[] }>;
  sending?: string;
};
const ledger = (store: Store) => store["users/u1/meta/alert-ledger"] as Ledger;

/**
 * A reader whose first night has been, with Halloween at the Rio; the next
 * night it's at the PCC too, which is news.
 */
async function newsTomorrow() {
  const store = reader("u1", { m1: "Halloween" });
  let movies: Movie[] = [film("m1", "Halloween", { rio: [at(1, 19)] })];
  serve({ movies: () => movies, store });
  await runNight(NOW);
  vi.setSystemTime(NEXT_NIGHT);
  movies = [film("m1", "Halloween", { rio: [at(1, 19)], pcc: [at(2, 20)] })];
  return store;
}

const SENDING = { DRY_RUN: "false" } as unknown as Partial<Env>;

describe("sending", () => {
  it("sends the email from the alerts address, to the reader, replies to one that's read", async () => {
    const store = await newsTomorrow();
    const email = fakeEmail();
    const night = await runNight(NEXT_NIGHT, {
      ...SENDING,
      EMAIL: email.binding,
    });
    expect(night).toMatchObject({ sent: 1, dryRun: false });
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({
      from: {
        email: "alert@alerts.clusterflick.com",
        name: "Clusterflick Alerts",
      },
      to: "u1@example.com",
      replyTo: "hello@clusterflick.com",
      subject: "Halloween: Now also at Prince Charles Cinema",
    });
    expect(ledger(store).runs[0]).toEqual({
      on: dayFrom(1),
      at: NEXT_NIGHT,
      outcome: "sent",
      films: 1,
    });
    // Told, so remembered; and the claim is gone.
    expect(ledger(store).films.m1.venues).toEqual(["rio", "pcc"]);
    expect(ledger(store).sending).toBeUndefined();
  });

  it("carries one-click unsubscribe, signed for the reader and the night", async () => {
    await newsTomorrow();
    const email = fakeEmail();
    await runNight(NEXT_NIGHT, { ...SENDING, EMAIL: email.binding });
    const headers = email.sent[0].headers ?? {};
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const link = headers["List-Unsubscribe"].slice(1, -1);
    expect(link).toMatch(
      new RegExp(
        `^https://alerts\\.clusterflick\\.com/unsubscribe\\?t=u1\\.${dayFrom(1)}\\.`,
      ),
    );
    // The footer links the same page.
    expect(email.sent[0].text).toContain(`Unsubscribe: ${link}`);
  });

  it("is never twice in a night", async () => {
    await newsTomorrow();
    const email = fakeEmail();
    await runNight(NEXT_NIGHT, { ...SENDING, EMAIL: email.binding });
    const again = await runNight(NEXT_NIGHT + 60_000, {
      ...SENDING,
      EMAIL: email.binding,
    });
    expect(again).toMatchObject({ alreadyRun: 1 });
    expect(email.sent).toHaveLength(1);
  });

  it("logs the message's id, never what's in it", async () => {
    await newsTomorrow();
    await runNight(NEXT_NIGHT, { ...SENDING, EMAIL: fakeEmail().binding });
    expect(logged(log, "alerts-sent")).toEqual([
      { event: "alerts-sent", uid: "u1", messageId: "message-1", films: 1 },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Halloween");
  });
});

describe("a refused send", () => {
  it("fails loudly, and keeps the news for the next night", async () => {
    const store = await newsTomorrow();
    const before = ledger(store).films;
    await expect(
      runNight(NEXT_NIGHT, {
        ...SENDING,
        EMAIL: fakeEmail("E_DELIVERY_FAILED").binding,
      }),
    ).rejects.toThrow("had failures");
    expect(ledger(store).runs[0]).toMatchObject({
      outcome: "failed",
      reason: REASONS.sendFailed,
    });
    expect(ledger(store).films).toEqual(before);
    expect(ledger(store).sending).toBeUndefined();
  });
});

describe("a claim left by a run that stopped", () => {
  it("isn't sent again, and says it can't tell whether it went", async () => {
    const store = await newsTomorrow();
    store["users/u1/meta/alert-ledger"] = {
      ...ledger(store),
      sending: dayFrom(1),
    };
    const email = fakeEmail();
    const night = await runNight(NEXT_NIGHT, {
      ...SENDING,
      EMAIL: email.binding,
    });
    expect(night).toMatchObject({ notResent: 1 });
    // No email to the reader; a notice to us.
    expect(email.sent.map(({ to }) => to)).toEqual(["hello@clusterflick.com"]);
    expect(email.sent[0].text).toContain("u1: notResent");
    expect(ledger(store).runs[0]).toMatchObject({
      outcome: "notResent",
      reason: REASONS.notResent,
    });
    // Remembered as if it went: never the same news twice.
    expect(ledger(store).films.m1.venues).toEqual(["rio", "pcc"]);
    expect(ledger(store).sending).toBeUndefined();
  });

  it("from an earlier night is no claim on tonight's", async () => {
    const store = await newsTomorrow();
    store["users/u1/meta/alert-ledger"] = {
      ...ledger(store),
      sending: TODAY,
    };
    const email = fakeEmail();
    await runNight(NEXT_NIGHT, { ...SENDING, EMAIL: email.binding });
    expect(email.sent).toHaveLength(1);
  });
});

describe("while trying alerts out", () => {
  it("sends nothing", async () => {
    await newsTomorrow();
    const email = fakeEmail();
    expect(await runNight(NEXT_NIGHT, { EMAIL: email.binding })).toMatchObject({
      previewed: 1,
    });
    expect(email.sent).toEqual([]);
  });
});
