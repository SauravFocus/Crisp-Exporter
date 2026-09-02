/**
 * Runnable checks for the export loop.  `node test-export.js`
 *
 * Loads main-world.js against a stub DOM and drives it the way the page does:
 * the inbox makes requests, we send popup commands, and we assert on what came
 * back out. Covers inbox-filter capture and replay, and the worker pool that
 * fetches conversations.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const WEBSITE = '00000000-0000-4000-8000-000000000000';
const LIST = `https://app.crisp.chat/api/v1/website/${WEBSITE}/conversations/1`;
const FILTER_QS = '?per_page=25&search_query=refund&search_type=segment';

// 12 conversations. Message counts cycle 1,2,3 and every 4th conversation
// opens with a private note, so the totals below are counted by hand rather
// than recomputed the way the code does.
const CONV_COUNT = 12;
const EXPECTED_MESSAGES = 24; // 1+2+3 repeated four times
const EXPECTED_NOTES = 3;     // conversations 0, 4 and 8
const FAILING = 5;            // messages endpoint returns 500 for this one

const posted = [];
const listeners = [];
let fetched = [];
let inFlight = 0;
let maxInFlight = 0;
let failMessagesFor = null;

function messagesFor(index) {
  const n = (index % 3) + 1;
  return Array.from({ length: n }, (_, k) => ({
    fingerprint: `f${index}-${k}`,
    from: 'user',
    content: `message ${k} about a refund`,
    timestamp: 1000 - k,
    type: index % 4 === 0 && k === 0 ? 'note' : 'text',
  }));
}

async function fakeFetch(url) {
  url = String(url);
  fetched.push(url);

  const list = /\/conversations\/(\d+)/.exec(url);
  if (list) {
    const items = Number(list[1]) === 1
      ? Array.from({ length: CONV_COUNT }, (_, i) => ({
          session_id: `sess-${i}`, state: 'resolved', meta: { nickname: `Visitor ${i}` },
        }))
      : [];
    return { ok: true, status: 200, json: async () => ({ data: items }) };
  }

  const msgs = /\/conversation\/sess-(\d+)\/messages/.exec(url);
  if (msgs) {
    const index = Number(msgs[1]);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 60)); // latency, so overlap is observable
    inFlight--;
    if (index === failMessagesFor) return { ok: false, status: 500, text: async () => 'boom' };
    // A second page (timestamp_before=…) repeats page one, which is how
    // fetchMessages knows it has reached the end.
    return { ok: true, status: 200, json: async () => ({ data: messagesFor(index) }) };
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
global.document = {
  createElement: () => ({ click() {}, style: {} }),
  body: { appendChild() {}, removeChild() {} },
  querySelector: () => null,
};
global.indexedDB = { open: () => { throw new Error('no indexedDB in node'); } };

eval(fs.readFileSync(path.join(__dirname, 'main-world.js'), 'utf8'));
const CE = global.window.__crispExporter;

const send = (command, payload = {}) =>
  Promise.all(listeners.map(fn =>
    fn({ source: global.window, data: { source: 'crispExporterCmd', command, payload } })));

async function ping() {
  posted.length = 0;
  await send('ping');
  return posted.find(m => m.type === 'pong').data;
}

function progressPhases() {
  return posted.filter(m => m.type === 'progress').map(m => m.data.phase);
}

async function waitFor(predicate, what, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = predicate();
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}; phases seen: ${progressPhases().join(', ')}`);
}

const waitForPhase = phase =>
  waitFor(() => posted.find(m => m.type === 'progress' && m.data.phase === phase), `phase "${phase}"`);

function reset() {
  fetched = []; posted.length = 0; inFlight = 0; maxInFlight = 0;
}

const results = () => CE.lastResult;

(async () => {
  // ── Inbox filter capture ──────────────────────────────────────────────
  assert.strictEqual((await ping()).inboxFilter, null, 'clean slate must report no filter');

  await global.window.fetch(LIST + '?per_page=25');
  assert.strictEqual((await ping()).inboxFilter, null, 'per_page alone is not a filter');

  await global.window.fetch(LIST + FILTER_QS);
  await global.window.fetch(`https://app.crisp.chat/api/v1/website/${WEBSITE}/conversation/sess-1/messages`);
  assert.strictEqual(CE.lastList.query, FILTER_QS, 'a non-list request clobbered the captured filter');
  assert.strictEqual((await ping()).inboxFilter, 'query=refund · type=segment');

  // ── A filtered export of a few conversations ──────────────────────────
  reset();
  const startedAt = Date.now();
  await send('startExport', { websiteId: WEBSITE, options: {} });
  await waitForPhase('complete');
  const elapsed = Date.now() - startedAt;

  const lists = fetched.filter(u => /\/conversations\//.test(u));
  assert.ok(lists.length >= 2, 'expected the list endpoint to be paged');
  for (const u of lists) {
    assert.ok(u.startsWith(`https://app.crisp.chat/api/v1/website/${WEBSITE}/conversations/`), `wrong base: ${u}`);
    assert.ok(u.endsWith(FILTER_QS), `filter dropped from: ${u}`);
  }

  const r = results();
  assert.strictEqual(r.conversations.length, CONV_COUNT, 'wrong number of conversations');
  assert.strictEqual(r.stats.totalConversations, CONV_COUNT);
  assert.strictEqual(r.stats.totalMessages, EXPECTED_MESSAGES, 'message total disagrees with the hand count');
  assert.strictEqual(r.stats.totalNotes, EXPECTED_NOTES, 'note total disagrees with the hand count');
  assert.strictEqual(r.stats.inboxFilter, 'query=refund · type=segment', 'export must record its own filter');

  // Order must survive the pool: slot i holds conversation i.
  assert.deepStrictEqual(
    r.conversations.map(c => c.sessionId),
    Array.from({ length: CONV_COUNT }, (_, i) => `sess-${i}`),
    'the worker pool scrambled conversation order'
  );
  assert.strictEqual(r.conversations[0].noteCount, 1, 'conversation 0 should carry one private note');
  assert.strictEqual(r.conversations[1].messageCount, 2);

  // The pool really overlapped, and never exceeded its own ceiling.
  assert.ok(maxInFlight > 1, `no concurrency: max in-flight was ${maxInFlight}`);
  assert.ok(maxInFlight <= 4, `pool exceeded its ceiling: ${maxInFlight} in flight`);

  // Sequential would be at least CONV_COUNT × (two 60ms calls + 200ms + 250ms).
  const sequentialFloor = CONV_COUNT * 570;
  assert.ok(elapsed < sequentialFloor * 0.6,
    `no speedup: ${elapsed}ms against a ${sequentialFloor}ms sequential floor`);
  console.log(`  ${CONV_COUNT} conversations in ${elapsed}ms (sequential floor ~${sequentialFloor}ms), max ${maxInFlight} in flight`);

  // Progress must count up once per conversation, never past the total.
  const dones = posted.filter(m => m.type === 'progress' && m.data.phase === 'fetching').map(m => m.data.done);
  assert.strictEqual(Math.max(...dones), CONV_COUNT, 'progress never reached the total');
  assert.deepStrictEqual([...new Set(dones)].sort((a, b) => a - b),
    Array.from({ length: CONV_COUNT }, (_, i) => i + 1), 'progress skipped or repeated a step');

  // ── A conversation whose messages fail is kept, in place, and empty ────
  reset();
  failMessagesFor = FAILING;
  await send('startExport', { websiteId: WEBSITE, options: {} });
  await waitForPhase('complete');
  failMessagesFor = null;

  const withFailure = results();
  assert.strictEqual(withFailure.conversations.length, CONV_COUNT, 'a failing conversation was dropped');
  assert.strictEqual(withFailure.conversations[FAILING].sessionId, `sess-${FAILING}`, 'failure shifted the order');
  assert.strictEqual(withFailure.conversations[FAILING].messageCount, 0);
  assert.strictEqual(withFailure.stats.totalMessages, EXPECTED_MESSAGES - messagesFor(FAILING).length,
    'the failed conversation still contributed messages');

  // ── Cancel stops the pool ─────────────────────────────────────────────
  reset();
  send('startExport', { websiteId: WEBSITE, options: {} });
  await waitFor(() => posted.find(m => m.type === 'progress' && m.data.phase === 'fetching' && m.data.done >= 2),
    'the export to get going');
  await send('cancelExport');
  await waitForPhase('cancelled');
  assert.ok(!progressPhases().includes('complete'), 'export completed despite being cancelled');
  assert.strictEqual(CE.exporting, false, 'exporting flag left set after cancel');

  // ── Opting out ignores the inbox filter ───────────────────────────────
  reset();
  await send('startExport', { websiteId: WEBSITE, options: { useInboxFilter: false } });
  await waitForPhase('complete');
  const plain = fetched.filter(u => /\/conversations\//.test(u));
  assert.ok(plain.length >= 2 && plain.every(u => !u.includes('search_query')), 'opt-out still sent the filter');
  assert.strictEqual(results().stats.inboxFilter, null, 'unfiltered export should record no filter');

  console.log('all checks passed');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
