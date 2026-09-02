/**
 * Runnable check for inbox-filter capture + replay.  `node test-inbox-filter.js`
 *
 * Loads main-world.js against a stub DOM and drives it the way the page does:
 * the inbox makes a filtered list request, we assert the export replays that
 * exact query instead of paging the unfiltered endpoint.
 */
const fs = require('fs');
const assert = require('assert');

const WEBSITE = '00000000-0000-4000-8000-000000000000';
const INBOX_LIST = `https://app.crisp.chat/api/v1/website/${WEBSITE}/conversations/1`;
const FILTER_QS = '?per_page=25&search_query=refund&search_type=segment';

const posted = [];
const listeners = [];
const fetched = [];

async function fakeFetch(url) {
  fetched.push(String(url));
  const page = /\/conversations\/(\d+)/.exec(url);
  if (page) {
    const items = Number(page[1]) === 1
      ? [{ session_id: 'sess-1', state: 'resolved', meta: { nickname: 'Alice' } }]
      : [];
    return { ok: true, status: 200, json: async () => ({ data: items }) };
  }
  if (/\/messages/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ data: [{ fingerprint: 'f1', from: 'user', content: 'refund please', timestamp: 1 }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: [] }) };
}

global.window = {
  fetch: fakeFetch,
  addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
  postMessage: msg => posted.push(msg),
};
global.XMLHttpRequest = function () {};
global.XMLHttpRequest.prototype.open = function () {};
global.XMLHttpRequest.prototype.setRequestHeader = function () {};
global.location = { href: `https://app.crisp.chat/website/${WEBSITE}/inbox/` };
global.document = { createElement: () => ({ click() {}, style: {} }), body: { appendChild() {}, removeChild() {} }, querySelector: () => null };
global.indexedDB = { open: () => { throw new Error('no indexedDB in node'); } };

eval(fs.readFileSync(require('path').join(__dirname, 'main-world.js'), 'utf8'));
const CE = global.window.__crispExporter;

const send = (command, payload = {}) =>
  Promise.all(listeners.map(fn => fn({ source: global.window, data: { source: 'crispExporterCmd', command, payload } })));

async function ping() {
  posted.length = 0;
  await send('ping');
  return posted.find(m => m.type === 'pong').data;
}

async function waitForPhase(phase, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = posted.find(m => m.type === 'progress' && m.data.phase === phase);
    if (hit) return hit.data;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`never reached phase "${phase}"; saw: ${posted.filter(m => m.type === 'progress').map(m => m.data.phase + (m.data.message ? '(' + m.data.message + ')' : '')).join(', ')}`);
}

(async () => {
  // Nothing seen yet → no filter to report.
  assert.strictEqual((await ping()).inboxFilter, null, 'clean slate must report no filter');

  // An unfiltered inbox request carries only paging, which is not a filter.
  await global.window.fetch(INBOX_LIST + '?per_page=25');
  assert.strictEqual((await ping()).inboxFilter, null, 'per_page alone is not a filter');

  // The messages endpoint must not overwrite the captured list request.
  await global.window.fetch(INBOX_LIST + FILTER_QS);
  await global.window.fetch(`https://app.crisp.chat/api/v1/website/${WEBSITE}/conversation/sess-1/messages`);
  assert.strictEqual(CE.lastList.query, FILTER_QS, 'a non-list request clobbered the captured filter');
  assert.strictEqual((await ping()).inboxFilter, 'query=refund · type=segment');

  // Export replays the captured base + query, page number swapped.
  fetched.length = 0; posted.length = 0;
  await send('startExport', { websiteId: WEBSITE, options: {} });
  await waitForPhase('complete');
  const lists = fetched.filter(u => /\/conversations\//.test(u));
  assert.ok(lists.length >= 2, 'expected the list endpoint to be paged');
  for (const u of lists) {
    assert.ok(u.startsWith(`https://app.crisp.chat/api/v1/website/${WEBSITE}/conversations/`), `wrong base: ${u}`);
    assert.ok(u.endsWith(FILTER_QS), `filter dropped from: ${u}`);
  }
  assert.deepStrictEqual(
    lists.map(u => u.match(/conversations\/(\d+)/)[1]),
    ['1', '1', '2', '3'],  // preflight, then paging
    'unexpected page sequence'
  );

  // Opting out ignores the inbox filter entirely.
  fetched.length = 0; posted.length = 0;
  await send('startExport', { websiteId: WEBSITE, options: { useInboxFilter: false } });
  await waitForPhase('complete');
  const plain = fetched.filter(u => /\/conversations\//.test(u));
  assert.ok(plain.length >= 2 && plain.every(u => !u.includes('search_query')), 'opt-out still sent the filter');

  console.log('all checks passed');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
