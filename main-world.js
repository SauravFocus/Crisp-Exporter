/**
 * Crisp Chat Exporter — Main World Script (MAIN world)
 * 
 * Runs independently of the popup. Export keeps running if popup closes.
 * Stores the result in window.__crispExporter.lastResult so the popup
 * (via content script) can grab it on reconnect.
 * 
 * NEVER stores large data in chrome.storage (5MB limit kills it).
 * Only small progress objects go to storage.
 */
(function() {
  'use strict';
  if (window.__crispExporter) return;

  window.__crispExporter = {
    authHeaders: {},
    ready: false,
    apiBase: null,
    apiBaseDefault: 'https://api.crisp.chat/v1',
    discoveredUrls: [],
    exporting: false,
    cancelled: false,
    lastList: null,    // ← last conversations-list request the inbox itself made
    lastResult: null   // ← full export data lives HERE in page memory
  };

  const CE = window.__crispExporter;

  // ── Intercept fetch ──
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (isCrispApiUrl(url)) {
        discoverApiBase(url);
        captureList(url);
        captureHeaders(init?.headers, input instanceof Request ? input.headers : null);
      }
    } catch(e) {}
    return origFetch.apply(this, arguments);
  };

  // ── Intercept XHR ──
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__crispUrl = url;
    if (isCrispApiUrl(url)) { discoverApiBase(url); captureList(url); }
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this.__crispUrl && isCrispApiUrl(this.__crispUrl)) recordHeader(name, value);
    return origXhrSetHeader.apply(this, arguments);
  };

  function isCrispApiUrl(url) {
    return url && (url.includes('api.crisp.chat') || url.includes('/v1/website/'));
  }
  function discoverApiBase(url) {
    try {
      const m = url.match(/(https?:\/\/[^/]+(?:\/v\d+)?)\/(website|bucket)\//);
      if (m && m[1] && !CE.discoveredUrls.includes(m[1])) {
        CE.discoveredUrls.push(m[1]);
        if (!CE.apiBase) CE.apiBase = m[1];
      }
    } catch(e) {}
  }
  // The inbox asks for /website/<id>/conversations/1?per_page=25&search_query=refund
  // &search_type=segment. Replaying that exact query is how the export follows whatever
  // filter is on screen, without modelling Crisp's filter semantics ourselves.
  const LIST_RE = /^(https?:\/\/[^?#]*\/website\/([a-f0-9-]{16,})\/conversations)\/\d+(\?[^#]*)?$/;
  function captureList(url) {
    try {
      const m = new URL(url, location.href).href.match(LIST_RE);
      if (m) CE.lastList = { prefix: m[1], websiteId: m[2], query: m[3] || '', at: Date.now() };
    } catch(e) {}
  }
  function filterSummary(list) {
    if (!list || !list.query) return null;
    const params = new URLSearchParams(list.query);
    params.delete('per_page');
    const parts = [];
    params.forEach((v, k) => parts.push(k.replace(/^(search|filter)_/, '') + '=' + v));
    return parts.length ? parts.join(' · ') : null;
  }
  function listPageUrl(websiteId, list, page) {
    return list ? list.prefix + '/' + page + list.query
                : getApiBase() + '/website/' + websiteId + '/conversations/' + page;
  }

  function captureHeaders(initH, reqH) {
    if (initH) {
      if (initH instanceof Headers) initH.forEach((v,k) => recordHeader(k,v));
      else if (typeof initH === 'object') Object.entries(initH).forEach(([k,v]) => recordHeader(k,v));
    }
    if (reqH instanceof Headers) reqH.forEach((v,k) => recordHeader(k,v));
  }
  function recordHeader(name, value) {
    const l = name.toLowerCase();
    if (l === 'authorization' || l.startsWith('x-crisp') || l === 'cookie') {
      CE.authHeaders[name] = value;
      CE.ready = true;
    }
  }
  function getApiBase() { return CE.apiBase || CE.apiBaseDefault; }

  // ── API fetch ──
  function apiFetch(endpoint, retries) {
    return apiFetchUrl(getApiBase() + endpoint, retries);
  }

  async function apiFetchUrl(url, retries) {
    retries = retries ?? 2;
    const headers = { 'Accept': 'application/json' };
    for (const [k,v] of Object.entries(CE.authHeaders)) headers[k] = v;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        let resp = await origFetch.call(window, url, { headers, credentials: 'include' });
        if (resp.status === 401 || resp.status === 403) {
          // Wait briefly — Crisp may refresh its own tokens, which our interceptors will capture
          await delay(2000);
          const freshHeaders = { 'Accept': 'application/json' };
          for (const [k,v] of Object.entries(CE.authHeaders)) freshHeaders[k] = v;
          resp = await origFetch.call(window, url, { headers: freshHeaders, credentials: 'include' });
        }
        if (resp.ok) return await resp.json();
        if (resp.status === 429) { await delay(Math.pow(2, attempt+1) * 1500); continue; }
        const t = await resp.text().catch(() => '');
        throw new Error('HTTP ' + resp.status + (t ? ': ' + t.substring(0, 120) : ''));
      } catch(e) {
        if (attempt === retries) throw e;
        await delay(1000 * (attempt+1));
      }
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Conversations are fetched by this many workers, each pausing CONV_PACE_MS
  // between its own conversations. Effective request rate is roughly the two
  // multiplied together; apiFetch already backs off exponentially on HTTP 429.
  // ponytail: fixed pool with no shared 429 governor — if Crisp starts rate
  // limiting, drop CONCURRENCY before raising the pace, or add a global pause
  // that every worker waits on when any one of them sees a 429.
  const CONCURRENCY = 4;
  const CONV_PACE_MS = 250;

  // ── IndexedDB persistence (survives page refresh / tab close) ──
  const IDB_NAME = 'crispExporterCache';
  const IDB_STORE = 'exports';
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveToCache(data) {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ data, savedAt: Date.now() }, 'latest');
        tx.oncomplete = res; tx.onerror = rej;
      });
      db.close();
    } catch(e) {}
  }

  async function loadFromCache() {
    try {
      const db = await idbOpen();
      const entry = await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get('latest');
        req.onsuccess = () => res(req.result);
        req.onerror = rej;
      });
      db.close();
      if (!entry || Date.now() - entry.savedAt > CACHE_TTL) return null;
      return entry.data;
    } catch(e) { return null; }
  }

  async function clearCache() {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete('latest');
        tx.oncomplete = res; tx.onerror = rej;
      });
      db.close();
    } catch(e) {}
  }

  // ── Pre-flight ──
  async function preflightCheck(websiteId, list) {
    try {
      const d = await apiFetchUrl(listPageUrl(websiteId, list, 1));
      return (d && d.data !== undefined) ? { ok: true } : { ok: false, error: 'Unexpected response' };
    } catch(e) { return { ok: false, error: e.message }; }
  }

  // ── Fetch all conversations (deduped by session_id) ──
  async function fetchAllConversations(websiteId, onProgress, list) {
    const convMap = new Map();
    let page = 1;
    let emptyPages = 0;

    while (page <= 500) {
      if (CE.cancelled) break;
      let data;
      try { data = await apiFetchUrl(listPageUrl(websiteId, list, page)); }
      catch(e) {
        if (page === 1) throw new Error('Failed to list conversations: ' + e.message);
        break;
      }
      const items = data?.data || [];
      if (!items.length) { emptyPages++; if (emptyPages >= 2) break; page++; continue; }
      emptyPages = 0;
      let newCount = 0;
      for (const c of items) {
        const sid = c.session_id || c.id;
        if (sid && !convMap.has(sid)) { convMap.set(sid, c); newCount++; }
      }
      if (newCount === 0) break;
      page++;
      if (onProgress) onProgress({ phase: 'listing', count: convMap.size });
      await delay(350);
    }
    return Array.from(convMap.values());
  }

  // ── Fetch messages (deduped) ──
  async function fetchMessages(websiteId, sessionId) {
    const all = []; const seen = new Set();
    let tsBefore = null; let iter = 0;
    while (iter < 100) {
      if (CE.cancelled) break;
      iter++;
      let ep = '/website/' + websiteId + '/conversation/' + sessionId + '/messages';
      if (tsBefore) ep += '?timestamp_before=' + tsBefore;
      let data;
      try { data = await apiFetch(ep); } catch(e) { break; }
      const msgs = data?.data || [];
      if (!msgs.length) break;
      let added = 0;
      for (const m of msgs) {
        const fp = String(m.fingerprint || (m.timestamp + ':' + String(m.content||'').substring(0,50)));
        if (!seen.has(fp)) { seen.add(fp); all.push(m); added++; }
      }
      if (added === 0) break;
      let oldest = Infinity;
      for (const m of msgs) { const ts = m.timestamp||m.created_at; if (ts!=null&&ts<oldest) oldest=ts; }
      if (oldest===Infinity||oldest===tsBefore) break;
      tsBefore = oldest;
      await delay(200);
    }
    return all;
  }

  // ── Helpers ──
  function extractMeta(c) {
    const meta = c.meta||{};
    const ops = (c.participants||[]).filter(p=>p.type==='operator'||p.role==='operator')
      .map(p=>p.nickname||p.name||p.email||'Unknown Operator');
    return {
      sessionId:c.session_id||c.id||'', visitorName:meta.nickname||meta.name||meta.email||c.nickname||'Unknown Visitor',
      visitorEmail:meta.email||'', operatorNames:ops.length?ops:['Unassigned'],
      status:c.state||c.status||'unknown', createdAt:c.created_at||c.timestamp||null,
      updatedAt:c.updated_at||null, tags:c.tags||c.segments||[],
      subject:c.subject||meta.subject||'', isBlocked:c.is_blocked||false,
      availability:c.availability||'', device:meta.device||{}, location:meta.location||meta.ip||{}
    };
  }
  function normalizeMsg(m) {
    let content = m.content||m.text||'';
    if (typeof content==='object'&&content!==null) {
      if (content.text) content=content.text;
      else if (content.url) content='[File: '+(content.name||content.url)+']';
      else if (content.title) content=content.title+(content.text?': '+content.text:'');
      else content=JSON.stringify(content);
    }
    const isNote = m.type==='note'||m.origin==='note'||(typeof m.type==='string'&&m.type.includes('note'));
    return { from:m.from||m.role||'unknown', fromName:m.user?.nickname||m.user?.name||m.from||'',
      type:m.type||'text', content:String(content), timestamp:m.timestamp||m.created_at||null,
      isNote, isAutomated:m.automated||m.origin==='automated'||false, fingerprint:m.fingerprint||null };
  }

  // ── MAIN EXPORT ──
  async function runExport(websiteId, options) {
    if (CE.exporting) { postUpdate({ phase:'error', message:'Export already running.' }); return; }

    CE.exporting = true;
    CE.cancelled = false;
    CE.lastResult = null;
    await clearCache();

    const results = {
      conversations:[], errors:[],
      stats:{ totalConversations:0, totalMessages:0, totalNotes:0, exportedAt:new Date().toISOString() }
    };

    try {
      // Follow the inbox's on-screen filter unless the popup opted out.
      const list = (options.useInboxFilter !== false && CE.lastList
        && CE.lastList.websiteId === websiteId && filterSummary(CE.lastList)) ? CE.lastList : null;
      const activeFilter = filterSummary(list);
      results.stats.inboxFilter = activeFilter;

      postUpdate({ phase:'starting', message:'Checking API access...' });
      const check = await preflightCheck(websiteId, list);
      if (!check.ok) {
        postUpdate({ phase:'error', message:'API check failed: '+check.error });
        postUpdate({ phase:'needDomFallback' });
        CE.exporting = false; return;
      }

      postUpdate({ phase:'listing', count:0,
        message: activeFilter ? 'Fetching filtered list (' + activeFilter + ')...' : 'Fetching conversation list...' });
      let convList;
      try {
        convList = await fetchAllConversations(websiteId, p => {
          postUpdate({ phase:'listing', message:'Found '+p.count+' conversations...', count:p.count });
        }, list);
      } catch(e) {
        postUpdate({ phase:'error', message:e.message });
        postUpdate({ phase:'needDomFallback' });
        CE.exporting = false; return;
      }
      if (CE.cancelled) { CE.exporting=false; postUpdate({phase:'cancelled'}); return; }
      if (!convList?.length) {
        postUpdate({ phase:'error', message: activeFilter
          ? 'No conversations matched the inbox filter (' + activeFilter + ').'
          : 'No conversations found.' });
        CE.exporting=false; return;
      }

      // Filters
      let filtered = convList;
      if (options.status&&options.status!=='all')
        filtered = filtered.filter(c=>(c.state||c.status||'').toLowerCase().includes(options.status.toLowerCase()));
      if (options.dateFrom) {
        const from = new Date(options.dateFrom).getTime();
        filtered = filtered.filter(c=>{ const ts=c.updated_at||c.created_at; if(!ts)return true; return(typeof ts==='number'?(ts>1e12?ts:ts*1000):new Date(ts).getTime())>=from; });
      }
      if (options.dateTo) {
        const to = new Date(options.dateTo).getTime()+86400000;
        filtered = filtered.filter(c=>{ const ts=c.created_at; if(!ts)return true; return(typeof ts==='number'?(ts>1e12?ts:ts*1000):new Date(ts).getTime())<=to; });
      }

      const total = filtered.length;
      results.stats.totalConversations = total;

      // Conversations are fetched by a small pool of workers pulling from a shared
      // cursor. Slots are written by index so the output keeps the inbox's order
      // regardless of which worker finishes first.
      const slots = new Array(total);
      let cursor = 0, done = 0;

      async function worker() {
        while (cursor < total && !CE.cancelled) {
          const i = cursor++;
          const meta = extractMeta(filtered[i]);
          try {
            const messages = await fetchMessages(websiteId, meta.sessionId);
            const norm = messages.map(normalizeMsg);
            const nc = norm.filter(m=>m.isNote).length;
            results.stats.totalMessages += norm.length;
            results.stats.totalNotes += nc;
            slots[i] = { ...meta, messages:norm, messageCount:norm.length, noteCount:nc };
          } catch(e) {
            results.errors.push({ sessionId:meta.sessionId, visitor:meta.visitorName, error:e.message });
            slots[i] = { ...meta, messages:[], messageCount:0, noteCount:0, fetchError:e.message };
          }
          done++;
          postUpdate({ phase:'fetching', total, done, current:meta.visitorName });
          // Checkpoint so a crash/navigation doesn't lose everything
          if (done % 50 === 0) {
            results.conversations = slots.filter(Boolean);
            saveToCache(results).catch(() => {});
          }
          if (cursor < total) await delay(CONV_PACE_MS);
        }
      }

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
      results.conversations = slots.filter(Boolean);

      if (CE.cancelled) { CE.exporting=false; postUpdate({phase:'cancelled'}); return; }

      // ★ Store in page memory (fast) AND IndexedDB (survives page refresh)
      CE.lastResult = results;
      await saveToCache(results);

      postUpdate({ phase:'complete', stats:results.stats, errorCount:results.errors.length });
      window.postMessage({ source:'crispExporter', type:'exportResult', data:{ stats:results.stats, errorCount:results.errors.length, errors:results.errors } }, '*');

    } catch(e) {
      postUpdate({ phase:'error', message:'Unexpected error: '+e.message });
    } finally {
      CE.exporting = false;
    }
  }

  function postUpdate(data) {
    window.postMessage({ source:'crispExporter', type:'progress', data }, '*');
  }

  // ── Command listener ──
  window.addEventListener('message', async (event) => {
    if (event.source!==window||!event.data||event.data.source!=='crispExporterCmd') return;
    const { command, payload } = event.data;

    if (command === 'ping') {
      window.postMessage({ source:'crispExporter', type:'pong', data:{
        ready:CE.ready, hasAuth:Object.keys(CE.authHeaders).length>0,
        exporting:CE.exporting, hasResult:!!CE.lastResult,
        inboxFilter:filterSummary(CE.lastList)
      }}, '*');
    }

    if (command === 'startExport') {
      runExport(payload.websiteId, payload.options||{});
    }

    if (command === 'cancelExport') {
      CE.cancelled = true;
    }

    if (command === 'getResult') {
      // Send full result data back to content script
      if (CE.lastResult) {
        // Chunk it to avoid postMessage size issues
        const json = JSON.stringify(CE.lastResult);
        const CHUNK = 4 * 1024 * 1024; // 4MB chunks
        const totalChunks = Math.ceil(json.length / CHUNK);
        for (let i = 0; i < totalChunks; i++) {
          window.postMessage({ source:'crispExporter', type:'resultChunk', data:{
            chunk: json.slice(i * CHUNK, (i+1) * CHUNK),
            index: i, total: totalChunks
          }}, '*');
        }
      } else {
        window.postMessage({ source:'crispExporter', type:'resultChunk', data:{ chunk:null, index:0, total:0 }}, '*');
      }
    }

    if (command === 'storeResult') {
      CE.lastResult = payload.result;
      saveToCache(CE.lastResult);
    }

    if (command === 'splitForClaude') {
      if (!CE.lastResult) CE.lastResult = await loadFromCache();
      if (!CE.lastResult) {
        window.postMessage({ source:'crispExporter', type:'splitComplete', data:{ totalChunks:0 }}, '*');
        return;
      }
      const chunkSize = Math.max(10, Math.min(500, payload.chunkSize || 100));
      const conversations = CE.lastResult.conversations || [];
      const total = conversations.length;
      const totalChunks = Math.ceil(total / chunkSize) || 1;
      const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
      const exportedAt = CE.lastResult.stats?.exportedAt || new Date().toISOString();

      for (let i = 0; i < totalChunks; i++) {
        const chunk = conversations.slice(i * chunkSize, (i + 1) * chunkSize);
        const chunkData = {
          _prompt_hint: 'Crisp support chat export. Analyze: (1) What issues are users facing? (2) How is the support team responding? (3) What patterns or recurring problems exist?',
          export_info: {
            chunk: `${i + 1} of ${totalChunks}`,
            conversations_in_chunk: chunk.length,
            total_conversations_in_export: total,
            exported_at: exportedAt
          },
          conversations: chunk
        };
        const blob = new Blob([JSON.stringify(chunkData, null, 2)], { type:'application/json;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `crisp-claude-${i + 1}-of-${totalChunks}-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        await delay(400);
      }
      window.postMessage({ source:'crispExporter', type:'splitComplete', data:{ totalChunks }}, '*');
    }

    if (command === 'downloadDirect') {
      if (!CE.lastResult) CE.lastResult = await loadFromCache();
      if (CE.lastResult) {
        const format = payload.format || 'json';
        const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
        const filename = 'crisp-export-' + ts + '.' + format;
        let content, mime;

        if (format === 'csv') {
          content = convertToCSV(CE.lastResult);
          mime = 'text/csv;charset=utf-8';
        } else {
          content = JSON.stringify(CE.lastResult, null, 2);
          mime = 'application/json;charset=utf-8';
        }

        const bom = format === 'csv' ? '\uFEFF' : '';
        const blob = new Blob([bom + content], { type: mime });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);

        window.postMessage({ source:'crispExporter', type:'downloadStarted', data:{ filename } }, '*');
      } else {
        window.postMessage({ source:'crispExporter', type:'downloadFailed', data:{ error:'Export data expired or not found. Please run a new export.' } }, '*');
      }
    }

  });

  // ── CSV converter (runs in page context to handle large data) ──
  function convertToCSV(data) {
    const hdr = ['Conversation ID','Visitor Name','Visitor Email','Operator(s)','Status','Tags',
      'Conversation Created','Conversation Updated','Message #','Message From','Sender Name',
      'Message Type','Is Private Note','Is Automated','Message Timestamp','Message Content'];
    const rows = [hdr.map(csvE).join(',')];
    for (const c of (data.conversations||[])) {
      if (c.messages?.length) {
        c.messages.forEach((m,i) => rows.push([c.sessionId||'',c.visitorName||'',c.visitorEmail||'',
          (c.operatorNames||[]).join('; '),c.status||'',(c.tags||[]).join('; '),
          fmtTs(c.createdAt),fmtTs(c.updatedAt),i+1,m.from||'',m.fromName||'',
          m.type||'text',m.isNote?'YES':'',m.isAutomated?'YES':'',
          fmtTs(m.timestamp),m.content||''].map(csvE).join(',')));
      } else {
        rows.push([c.sessionId||'',c.visitorName||'',c.visitorEmail||'',
          (c.operatorNames||[]).join('; '),c.status||'',(c.tags||[]).join('; '),
          fmtTs(c.createdAt),fmtTs(c.updatedAt),0,'','','','','','',
          c.fetchError?'[Error: '+c.fetchError+']':'[No messages]'].map(csvE).join(','));
      }
    }
    return rows.join('\r\n');
  }
  function csvE(v) { if(v==null) return '""'; const s=String(v); return /[,"\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
  function fmtTs(ts) { if(!ts)return''; try{ const d=typeof ts==='number'?(ts>1e12?new Date(ts):new Date(ts*1000)):new Date(ts); return isNaN(d.getTime())?String(ts):d.toISOString().replace('T',' ').replace(/\.\d+Z$/,' UTC'); }catch(e){return String(ts);} }

  // Recover last result from IndexedDB in case the page navigated mid-session
  loadFromCache().then(cached => { if (cached && !CE.lastResult) CE.lastResult = cached; }).catch(() => {});

  window.postMessage({ source:'crispExporter', type:'injected' }, '*');
})();
