# Crisp Chat Exporter — Claude Code Reference

## What This Is
A Chrome Manifest V3 extension that exports conversations from `app.crisp.chat` as CSV or JSON — **no Crisp API key required**. It works by intercepting the web app's own `fetch`/`XHR` calls to capture auth tokens, then replays those authenticated requests to the Crisp API.

---

## Architecture: Dual-World Design

The most important concept in this codebase. Chrome MV3 content scripts can run in two isolated JS worlds:

| World | File | Has access to | Cannot |
|-------|------|--------------|--------|
| MAIN | `main-world.js` | Page's JS scope, intercept fetch/XHR | Use `chrome.*` APIs |
| ISOLATED | `content.js` | `chrome.*` APIs (storage, runtime) | Read page variables |

The two worlds communicate **only via `window.postMessage`**.

```
popup.js
  └─ chrome.tabs.sendMessage()
       └─ content.js (ISOLATED)
            └─ window.postMessage({ source: 'crispExporterCmd' })
                 └─ main-world.js (MAIN)
                      └─ window.postMessage({ source: 'crispExporter' })
                           └─ content.js
                                └─ chrome.runtime.sendMessage()
                                     └─ popup.js
```

---

## File Map

| File | World | Purpose |
|------|-------|---------|
| `manifest.json` | — | Extension config, MV3 permissions, script declarations |
| `main-world.js` | MAIN | Auth header capture, Crisp API calls, export loop, CSV/JSON generation, downloads, IndexedDB cache |
| `content.js` | ISOLATED | postMessage bridge, DOM fallback export |
| `background.js` | Service Worker | Stores small export stats in chrome.storage |
| `popup.html` | — | Extension UI structure |
| `popup.css` | — | Dark theme (DM Sans + JetBrains Mono, GitHub-inspired palette) |
| `popup.js` | — | UI logic, storage polling, event bindings |

---

## Storage Strategy (Critical)

**Never store full conversation data in `chrome.storage` — 5 MB limit is easily exceeded.**

| Store | What goes in it | Why |
|-------|----------------|-----|
| `chrome.storage.local` | Progress phase, counts, up to 50 error objects | Tiny, cross-context readable |
| `IndexedDB` (`crispExporterCache`) | Full export JSON, 24h TTL | Unlimited size, survives page refresh |
| `CE.lastResult` (page memory) | Full export JSON, fast access | Lost on page refresh — auto-recovered from IndexedDB |

### IndexedDB key details
- DB: `crispExporterCache`, store: `exports`, key: `'latest'`
- Entry shape: `{ data: exportObject, savedAt: Date.now() }`
- Cleared when a new export **starts** (prevents stale data)
- Auto-recovered in `downloadDirect` and `splitForClaude` if `CE.lastResult` is null

---

## postMessage Command Protocol

### popup → page (via content.js)
```js
{ source: 'crispExporterCmd', command: 'startExport', payload: { websiteId, options } }
{ source: 'crispExporterCmd', command: 'downloadDirect', payload: { format } }
{ source: 'crispExporterCmd', command: 'splitForClaude', payload: { chunkSize } }
{ source: 'crispExporterCmd', command: 'cancelExport', payload: {} }
{ source: 'crispExporterCmd', command: 'ping', payload: {} }
{ source: 'crispExporterCmd', command: 'getResult', payload: {} }
{ source: 'crispExporterCmd', command: 'storeResult', payload: { result } }
```

### page → popup (via content.js)
```js
{ source: 'crispExporter', type: 'progress', data: { phase, count, total, done, current } }
{ source: 'crispExporter', type: 'exportResult', data: { stats, errorCount, errors } }
{ source: 'crispExporter', type: 'pong', data: { ready, hasAuth, exporting, hasResult } }
{ source: 'crispExporter', type: 'downloadStarted', data: { filename } }
{ source: 'crispExporter', type: 'downloadFailed', data: { error } }
{ source: 'crispExporter', type: 'splitComplete', data: { totalChunks } }
```

### Progress phases (in order)
`starting` → `listing` → `fetching` → `complete`
or → `error` | `cancelled` | `needDomFallback`

---

## Key Flags & State

### popup.js `state` object
```js
{
  tabId,               // active Crisp tab
  websiteId,           // parsed from URL or content script
  exporting,           // true while export is running
  hasResult,           // true after export completes
  pollTimer,           // setInterval ID for storage polling
  pendingAutoDownload  // true from startExport() → consumed on first completion
}
```

`pendingAutoDownload` prevents re-downloading when the popup is reopened to view stored results. It is only set by `startExport()` and is in-memory only.

---

## Export Data Shape

```js
{
  conversations: [{
    sessionId, visitorName, visitorEmail,
    operatorNames: [],
    status, createdAt, updatedAt, tags,
    messages: [{
      from, fromName, type, content,
      timestamp, isNote, isAutomated, fingerprint
    }],
    messageCount, noteCount, fetchError?
  }],
  errors: [{ sessionId, visitor, error }],
  stats: { totalConversations, totalMessages, totalNotes, exportedAt }
}
```

---

## How to Reload After Code Changes

1. Go to `chrome://extensions`
2. Find **Crisp Chat Exporter**, click the **refresh (↺) icon**
3. Refresh the `app.crisp.chat` tab
4. Open the inbox, then click the extension icon

> Content scripts need the tab to be refreshed after extension reload.

---

## Permissions Explained

| Permission | Why |
|------------|-----|
| `activeTab` | Access active tab when popup opens |
| `scripting` | Inject `main-world.js` and `content.js` if not already loaded |
| `downloads` | Declared but unused — downloads use blob URLs in page context |
| `storage` | `chrome.storage.local` for progress data |
| `host_permissions: app.crisp.chat/*` | Required for URL access in `chrome.tabs.query` and script injection |

---

## Version
`manifest.json`: `1.2.0` | popup display: `v1.2`
