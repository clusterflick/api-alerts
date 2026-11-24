# api-alerts

> **[Clusterflick](https://clusterflick.com)** is the most complete guide to
> film in London: every listing from 500+ venues, from multiplexes to pub back
> rooms, in one search. Free and open source.
>
> This repository is the Cloudflare Worker behind its email alerts: a daily
> email when films on a reader's watchlist are showing. See the
> [Clusterflick organisation](https://github.com/clusterflick) for how the
> pieces fit together.

Alerts need `emailAlerts`, a capability the site grants one account at a
time, and invitation-only for now. A reader switches them on, and chooses what
counts as news, at `/personalise/alerts/` on the site.

It sends, from 17 November 2026. `DRY_RUN` set to anything but `"false"` goes
back to working out each reader's email and recording it as one that would have
gone, sending nothing.

It's at `https://alerts.clusterflick.com`.

## What's news

The Worker reads the listings the site publishes, as the reader sees them
(through `@clusterflick/catalogue`'s `fetch-listings`), and compares each
watchlist film with what the reader's ledger remembers of it from the last
run (`src/news.ts`). Nothing from the pipeline's change sets: the listings
have every venue a film is at, and formats, notes and links already joined in.

| Trigger          | News when                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `firstListing`   | It's showing, and the ledger last saw it showing more than 30 days ago, or never since it was added. |
| `newVenue`       | It's at a venue the ledger hasn't seen it at.                                                        |
| `newPerformance` | A performance the ledger doesn't know, at any venue.                                                 |

`newVenue` counts any cinema unless the reader has chosen only their
favourite venues (`newVenueScope: "favourites"`, read with the watchlist from
`users/{uid}`'s `favouriteVenues`), since a film on general release reaches
more multiplexes almost every night. Every venue is still remembered, so a
venue that wasn't a favourite is never news later, and changing the choice
reports nothing old. It narrows that trigger only: a first listing is news
wherever it is. Settings without a scope, saved before there was a choice,
count any cinema.

A film the ledger doesn't know yet was added since the last run, which knows
nothing of what it was doing then, so it's judged by when it was added
(`addedAt`) against when the pipeline first saw each of its showings (`seen`,
in the site's listings): listed only after it was added is a first listing,
and venues it reached after are new, so a film added in the morning and listed
that afternoon is news that night. A showing first seen up to 6 hours before
the film was added counts as after (`PUBLISH_LAG_MS`): the site publishes some
hours after the pipeline sees a showing. A film already showing when it was
added isn't news: the reader was looking at it on the site. Without a run or a
switch-on to judge from, or a `seen` on every showing, it's remembered as it
stands and isn't news. A trigger that's off still
remembers, so switching it on doesn't report everything at once; the
performances are only kept while `newPerformance` is on, so the ledger stays
small. A film taken off the watchlist is forgotten. A film screened inside an
event (a double bill) counts, and the email says which event.

## The ledger

`users/{uid}/meta/alert-ledger`, which only this Worker writes (the site's
rules let the reader read and delete it):

- `runs`: the last 30, newest first, each `{ on, at, outcome, films?, reason? }`,
  shaped in `@clusterflick/accounts/alerts`, which the site's panel reads to
  say when alerts last ran and how that went.
- `films`: what the last run saw of each watchlist film (`FilmMemory` in
  `src/news.ts`).

A run writes it only if nothing else has since it read it (`commit` with an
`updateTime` precondition), and a reader's run happens once a night: a second
run the same night finds tonight's entry and leaves them be.

## The nightly run

`0 20 * * *` (8pm in winter, 9pm under BST, for now), in `src/run.ts`:

1. Read the listings once. If they can't be read, every reader's run fails,
   loudly, rather than finding nothing new, and their ledger keeps what it
   remembered.
2. Find every reader with alerts switched on: a collection-group query on
   `meta` for `enabled == true`, which needs the index in the site's
   `firestore.indexes.json`.
3. For each, one at a time: their settings, the capability, the address the
   site saved with the settings, their watchlist and their ledger; then the
   news, the email, and the ledger written. A reader without the capability is
   skipped and told why; one with no address saved fails and is told to save
   again.
   Sending (`src/send.ts`, once `DRY_RUN` is `"false"`) is through Cloudflare
   Email Service's binding, from `alert@alerts.clusterflick.com` (the one
   address the binding allows), with replies to `REPLY_TO`. Before sending,
   the run claims the night's email in the ledger (`sending: <date>`, written
   with a precondition, so only one run can); after, it records the run and
   clears the claim. A run that finds tonight's claim with no run recorded
   can't tell whether that email went, so it doesn't send, records
   `notResent`, and remembers as if it went: missing an email is better than
   sending one twice. A send Email Service refuses fails the reader's run and
   keeps their news for the next night.
4. Record the night in `alertRuns/{date}` (readers, and how many of each
   outcome), which no client can read. Any failure fails the run, so it shows
   in Workers Logs, and a night with a failure or a `notResent` is emailed to
   `REPLY_TO` that evening: who, and why.

Logs say what happened to each reader by uid, never what's on their watchlist.

## The preview

`POST /preview`, signed in with the reader's Firebase ID token, from the
site's pages only (CORS), behind the capability, and 10 a minute per reader
(`READER_LIMIT`, shared with `/remember`):
the email their alerts would send, worked out now, never sent or written
(`src/preview.ts`). It takes the triggers being edited, so it follows the
switches on the settings page.

- `{ "mode": "sinceLastRun", "notify": [...] }`: tonight's email so far,
  against the ledger. Before the first run there's nothing to compare with,
  and it says so (`baseline: true`).
- `{ "mode": "everythingShowing", "notify": [...] }`: every watchlist film
  that's showing, as if each were new, to see the email with real listings.

## Switching alerts on

`POST /remember`, which the settings page sends when a reader switches alerts
on (`src/remember.ts`): every film on their watchlist remembered as it stands
now, as a first run would, and no run recorded. That night's run then compares
against the moment they switched on, so a film listed that afternoon is news
the same evening, rather than the first night only remembering. Every
switch-on, not just the first, so turning alerts back on after a month off
starts from now rather than sending a month at once. Signed in as the preview
is, sharing its limit, only while alerts are on, and behind the capability. If
it fails, the alerts are still on, and the first night remembers instead.

## Unsubscribing

`src/unsubscribe.ts`, without signing in. Each email carries a link signed for
its reader and its date (HMAC-SHA256 with `UNSUBSCRIBE_SECRET`), which never
expires, as an unsubscribe link mustn't:

- **One-click** (`List-Unsubscribe` and `List-Unsubscribe-Post`, RFC 8058, as
  Gmail and Yahoo ask of senders): the mail client's `POST /unsubscribe?t=…`
  unsubscribes at once.
- **The footer link** opens a page with an Unsubscribe button, which makes the
  same `POST`. Following the link changes nothing, since mail scanners follow
  links.

Unsubscribing switches the reader's alerts off (only `enabled`, through an
update mask) and records `stopped: { reason, at, emailOn }` in their ledger, in
one commit, for the site's panel to say when and from which email. A link for
an account that's gone does nothing. Switching alerts back on is the reader's
to do, on the site.

## Bounces and complaints

`src/events.ts`, the `alert-events` queue's consumer. An event subscription on
`alerts.clusterflick.com`'s sending (set up in the dashboard: Queues →
`alert-events` → Subscriptions, for bounced, complained, rejected and failed)
publishes what Email Service says happened to each email:

| Event                                           | Done                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Hard bounce, spam complaint                     | The reader's alerts switched off, `stopped` in their ledger saying why, and a notice |
| Soft bounce (retries ran out), rejected, failed | A notice only: a full mailbox or our own mistake isn't the reader asking to stop     |
| Delivered, deferred                             | Nothing                                                                              |

The reader is found by the address, which their alert settings hold (a
collection-group query on `meta`'s `email`, which needs its index in the
site's `firestore.indexes.json`). The notice goes to `REPLY_TO`, never about
`REPLY_TO` itself, so a bounce can't loop. Email Service suppresses bounced
and complaining addresses itself as well; this is so the reader's panel says
why, and we know. A message that fails (Firestore down) is retried, up to 5
times.

## The email

`src/digest.ts`: grouped by film, at most 10, each with what's new about it,
its title linking to its page; the rest counted and linked.

- **The most interesting make the cut.** A first listing ranks above a film
  reaching new venues, which ranks above new showings where it already was.
  Within each, a film at fewer venues ranks higher, since a third venue for
  a film at two is bigger news than an eighteenth for a wide release; then
  the soonest showing, then the title. The top film is the subject.
- **Then they read in that order, alphabetically in each tier** ("The Fly"
  under F), so a film is easy to find.
- **A line per venue** (and per event at it), soonest first, with up to 3 of
  its times, the day named only when it changes ("Fri 13:30, 15:10, Sat
  11:00"); up to 3 venues, the rest counted. Each venue links to the film's
  page filtered to it (`?base=all&venues=…`, the site's own filter params),
  never to a booking page: an email can't be updated once sent, and a
  venue's booking links change more often than the site's.

Plain HTML that reads the same in every mail client, with a text version.
The footer says why it came and links to the settings (and, once sending,
to unsubscribe).

## Working on it

```bash
npm install
npm test          # Vitest in the Workers runtime
npm run lint      # tsc over the Worker and the tests
npm run dev       # http://localhost:8790
```

`npm test` runs against fakes of the site, Google and Firestore (which keeps
its writes, with the times it made them, for the preconditions), with a
service account and a Firebase key made up for the tests; its bindings are
pinned in `vitest.config.ts`, so nothing in `.dev.vars` reaches it.

`npx wrangler dev --test-scheduled` and a request to
`/__scheduled?cron=0+20+*+*+*` runs the night locally, against the live
project: copy `.dev.vars.example` to `.dev.vars` with this Worker's service
account key first.

## Deployment

`.github/workflows/deploy.yml` lints and tests every push and pull request,
and deploys on pushes to `main`. The service account key is a secret stored
on the Worker: it persists across deploys and never goes in the repo or CI.

`alerts.clusterflick.com` is a custom domain (`wrangler.jsonc`'s `routes`):
Cloudflare makes its DNS record and certificate on the first deploy. It's
also the domain the emails are sent from; its sending records sit on
`cf-bounce.alerts` and `_dmarc.alerts`, beneath it.

### The service account

In the Google Cloud console for `clusterflick-com`, under IAM → Service
accounts, one for this Worker alone, `api-alerts`, with the **Cloud Datastore
User** role (`roles/datastore.user`) and nothing else: it reads a reader's
settings, capabilities and watchlist, and writes their ledger and the night's
record. That role reads and writes every document in the project, since
Firestore has no narrower IAM role; what this Worker touches is limited by
its code.

### First deploy

As the other Workers': CI can't create a Worker whose `wrangler.jsonc`
requires a secret, and `wrangler secret put` only works on one that exists.
So the first deploy is from a machine with the key, creating the Worker and
its secret together, from a file holding only the secret:

```sh
grep "^FIREBASE_SERVICE_ACCOUNT=" .dev.vars > /tmp/alerts.env
npx wrangler deploy --secrets-file /tmp/alerts.env
rm /tmp/alerts.env
```

CI deploys with the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, as the other Workers do.

`UNSUBSCRIBE_SECRET` was added after the first deploy, and has to be on the
Worker before a deploy that requires it. A long random string nobody needs to
see, so generated straight into the secret:

```sh
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put UNSUBSCRIBE_SECRET
```

Changing it breaks every unsubscribe link already sent, so it's never rotated
casually.

## Licence

MIT, as the site.
