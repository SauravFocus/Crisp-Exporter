# Crisp Chat Exporter

A Chrome extension (Manifest V3) that exports conversations out of
[app.crisp.chat](https://app.crisp.chat) as CSV or JSON — **no Crisp API key
required**, and it exports exactly what your inbox filter is showing.

It works by intercepting the Crisp web app's own `fetch`/`XHR` calls to capture
the auth headers your session already carries, then replaying authenticated
requests against the same API. You stay logged in; nothing is sent anywhere
except Crisp.

---

## Install

Not on the Chrome Web Store — load it unpacked:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Open `app.crisp.chat`, go to your inbox, click the extension icon

> After changing any code you must hit the **↺ refresh** icon on the extension
> card *and* refresh the Crisp tab. Content scripts are injected at page load,
> so an un-refreshed tab is still running the old copy.

---

## Using it

1. Open your Crisp inbox. **Apply a filter if you want one** — a custom filter,
   a segment, a search, anything the inbox supports.
2. Click the extension icon.
3. If a filter is active, the popup shows a card naming it. Leave the checkbox
   ticked to export only those conversations, or untick it to export everything.
4. Pick **CSV** or **JSON**, hit **Start Export**.
5. The file downloads automatically when the export finishes.

### The inbox filter

The extension does not model Crisp's filter semantics. It captures the
conversation-list request the inbox itself makes — query string and all — and
replays that exact URL, swapping only the page number:

```
inbox asks for:  /api/v1/website/<id>/conversations/1?per_page=25&search_query=refund&search_type=segment
export replays:  /conversations/1 … /2 … /3   with the same query
```

Which means custom filters, segments, searches and date ranges all work, and
anything Crisp adds later works too, without a code change.

If the popup shows no filter card, no filter was seen and you will get the
whole inbox. The popup always tells you which of the two is about to happen.

### The popup's own Filters panel

Separate thing, easy to confuse. The collapsible **Filters** panel (status,
date from/to) is applied *locally, after* the conversations are downloaded. It
is a second sieve on top of whatever the inbox filter already selected — useful
for trimming, not for reducing what gets fetched.

---

## What you get

**CSV** — one row per message, so a conversation spans as many rows as it has
messages. Conversations with no messages still get one row. Columns:

```
Conversation ID · Visitor Name · Visitor Email · Operator(s) · Status · Tags
Conversation Created · Conversation Updated · Message # · Message From
Sender Name · Message Type · Is Private Note · Is Automated
Message Timestamp · Message Content
```

Written with a UTF-8 BOM so Excel opens it without mangling accents.

**JSON** — the full structure, nothing flattened:

```jsonc
{
  "conversations": [{
    "sessionId": "…", "visitorName": "…", "visitorEmail": "…",
    "operatorNames": ["…"], "status": "resolved",
    "createdAt": 0, "updatedAt": 0, "tags": ["…"],
    "messages": [{
      "from": "user", "fromName": "…", "type": "text", "content": "…",
      "timestamp": 0, "isNote": false, "isAutomated": false, "fingerprint": "…"
    }],
    "messageCount": 0, "noteCount": 0
  }],
  "errors": [{ "sessionId": "…", "visitor": "…", "error": "…" }],
  "stats": {
    "totalConversations": 0, "totalMessages": 0, "totalNotes": 0,
    "exportedAt": "ISO-8601",
    "inboxFilter": "query=refund · type=segment"
  }
}
```

`stats.inboxFilter` is `null` when the export was unfiltered, so a file always
says what it contains.

Private notes are included and flagged (`isNote`), so internal commentary comes
through alongside the customer-facing messages.

Files land as `crisp-export-<timestamp>.csv` / `.json`.

---

## Extras

**Analyzer** — the **Analyze** button opens a local dashboard page. Drop an
exported JSON onto it and it charts common user queries (word and bigram
frequency), operator performance, status distribution, top tags, temporal
patterns by hour and weekday, conversation length and message-type breakdown.
Everything runs in your browser; the file never leaves the machine.

**Split for Claude** — breaks a finished export into numbered JSON chunks
(10–500 conversations each, default 100) so a large export fits inside an LLM
context window. Each chunk carries its own header saying which part it is and a
prompt hint. Files are named `crisp-claude-<i>-of-<n>-<timestamp>.json`.

---

## Long exports

Conversations are fetched by a pool of four workers, each pausing 250 ms
between its own conversations, with 200 ms between message pages and
exponential backoff on HTTP 429. Output keeps the inbox's order regardless of
which worker finishes first.

Both knobs sit together at the top of `main-world.js`:

```js
const CONCURRENCY = 4;      // conversations fetched at once
const CONV_PACE_MS = 250;   // each worker's pause between conversations
```

If Crisp starts rate limiting, lower `CONCURRENCY` before raising the pace.

It is built so a long run survives real life:

- The export loop lives in the **page**, not the popup. Closing the popup does
  not stop it; reopening reattaches to the running export and its progress bar.
- Results are checkpointed to **IndexedDB every 50 conversations** and again at
  the end, with a 24-hour TTL. A page refresh or a closed tab does not lose the
  work — reopen the popup and the download is still there.
- Full data never touches `chrome.storage`, which caps at 5 MB. Only small
  progress objects and up to 50 error records go there.
- **Cancel** stops cleanly between conversations rather than mid-request.
- If the API is unreachable, it falls back to scraping the rendered inbox DOM.
  Lower fidelity, but it returns something.

Per-conversation failures are recorded in `errors[]` and the export continues.

---

## How it works

Chrome MV3 runs content scripts in two isolated worlds, and this extension
needs both:

| World | File | Can | Cannot |
|---|---|---|---|
| MAIN | `main-world.js` | See the page's JS, intercept `fetch`/`XHR` | Use `chrome.*` |
| ISOLATED | `content.js` | Use `chrome.*` | Read page variables |

They talk only over `window.postMessage`:

```
popup.js → content.js (ISOLATED) → main-world.js (MAIN) → back again
```

`main-world.js` does the real work: header capture, list-URL capture, the
export loop, CSV generation, and the blob download — all in page context, which
is what keeps large exports clear of extension storage limits.

Full internals — the command protocol, storage strategy, state flags — are in
[CLAUDE.md](CLAUDE.md).

---

## Files

| File | World | Purpose |
|---|---|---|
| `manifest.json` | — | MV3 config, permissions, script declarations |
| `main-world.js` | MAIN | Auth + list-URL capture, API calls, export loop, CSV/JSON, downloads, IndexedDB |
| `content.js` | ISOLATED | postMessage bridge, DOM fallback export |
| `background.js` | worker | Mirrors export stats into `chrome.storage` |
| `popup.html/.css/.js` | — | Extension UI |
| `analyzer.html/.js` | — | Local analysis dashboard |
| `test-export.js` | — | Node checks for filter capture, replay and the worker pool |

---

## Development

```bash
node test-export.js    # no dependencies, runs in a few seconds
```

It loads `main-world.js` against a stub DOM and drives it the way the page
does, running a full twelve-conversation export against a fake Crisp. It
asserts that a filtered inbox request is captured and replayed on every list
page, that paging-only params are not mistaken for a filter, that the opt-out
exports everything, that message and note totals match a hand count, that the
worker pool overlaps without exceeding its ceiling, that output order and
progress counting survive the pool, that a conversation whose messages fail is
still kept in place, and that cancelling stops the pool.

No build step, no dependencies, no bundler. Edit the files, refresh the
extension, refresh the Crisp tab.

---

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the active tab when the popup opens |
| `scripting` | Inject the scripts if the tab predates the extension |
| `storage` | Small progress objects only |
| `downloads` | Declared but unused — downloads go through blob URLs in page context |
| `host_permissions: app.crisp.chat/*` | Tab query and script injection |

No remote endpoints, no analytics, no telemetry. Your conversation data goes
from Crisp to your disk and nowhere else.

---

## Limits

- Crisp only. Requires an active logged-in `app.crisp.chat` session.
- Cold start: if you reload the extension while a Crisp tab is already open,
  that tab's injected script has observed no requests yet, so it has no auth
  headers and no filter. Refresh the tab.
- Cached export data expires after 24 hours.
- Paging stops at 500 list pages per export.

## Version

`1.2.0`
