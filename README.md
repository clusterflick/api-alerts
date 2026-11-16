# api-alerts

> **[Clusterflick](https://clusterflick.com)** is a free, open-source site
> listing every film showing in London, from 450+ venues in one search.
>
> This repository is the Cloudflare Worker behind its email alerts: a daily
> email when films on a reader's watchlist are showing. See the
> [Clusterflick organisation](https://github.com/clusterflick) for how the
> pieces fit together.

Alerts need `emailAlerts`, a capability the site grants one account at a
time, and invitation-only for now. A reader switches them on, and chooses what
counts as news, at `/personalise/alerts/` on the site.

**For now it sends nothing** (`DRY_RUN`): the nightly run works out each
reader's email and records it as one that would have gone, and the site's
settings page previews it. Sending, one-click unsubscribe and bounce handling
come next.

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

A film the ledger doesn't know yet, new to the watchlist or the alerts, is
remembered as it stands and isn't news: one already showing when it's added is
one the reader is looking at on the site. A trigger that's off still
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
4. Record the night in `alertRuns/{date}` (readers, and how many of each
   outcome), which no client can read. Any failure fails the run, so it shows
   in Workers Logs.

Logs say what happened to each reader by uid, never what's on their watchlist.

## The preview

`POST /preview`, signed in with the reader's Firebase ID token, from the
site's pages only (CORS), behind the capability, and 10 a minute per reader:
the email their alerts would send, worked out now, never sent or written
(`src/preview.ts`). It takes the triggers being edited, so it follows the
switches on the settings page.

- `{ "mode": "sinceLastRun", "notify": [...] }`: tonight's email so far,
  against the ledger. Before the first run there's nothing to compare with,
  and it says so (`baseline: true`).
- `{ "mode": "everythingShowing", "notify": [...] }`: every watchlist film
  that's showing, as if each were new, to see the email with real listings.

## The email

`src/digest.ts`: grouped by film, at most 10, each with what's new about it
and its first 3 showings (day, time, venue), its title linking to its page;
the rest counted and linked. Plain HTML that reads the same in every mail
client, with a text version. The footer says why it came and links to the
settings (and, once sending, to unsubscribe).

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

## Licence

MIT, as the site.
