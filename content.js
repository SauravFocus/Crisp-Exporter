/**
 * Crisp Chat Exporter — Content Script (ISOLATED world)
 * 
 * Only stores SMALL progress data in chrome.storage (phase, counts).
 * Full export data stays in the main-world page memory.
 * Downloads happen in page context via the 'downloadDirect' command.
 */

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'crispExporter') return;
  const { type, data } = event.data;

  // Store ONLY small progress data in chrome.storage
  if (type === 'progress') {
    const small = { phase: data.phase, count: data.count, total: data.total, done: data.done,
      current: data.current, message: data.message,
      statsConv: data.stats?.totalConversations, statsMsg: data.stats?.totalMessages, statsNotes: data.stats?.totalNotes,
      errorCount: data.errorCount };
    chrome.storage.local.set({
      exportProgress: small,
      exportInProgress: data.phase !== 'error' && data.phase !== 'cancelled' && data.phase !== 'complete',
      exportTimestamp: Date.now()
    });
  }

  if (type === 'exportResult') {
    // Only store stats and capped errors, NOT the full conversation data
    chrome.storage.local.set({
      exportInProgress: false,
      exportProgress: { phase: 'complete', statsConv: data.stats?.totalConversations,
        statsMsg: data.stats?.totalMessages, statsNotes: data.stats?.totalNotes,
        errorCount: data.errorCount, errors: (data.errors || []).slice(0, 50) },
      exportHasResult: true,
      exportTimestamp: Date.now()
    });
  }

  if (type === 'exportError') {
    chrome.storage.local.set({
      exportInProgress: false, exportHasResult: false,
      exportProgress: { phase: 'error', message: data.error },
      exportTimestamp: Date.now()
    });
  }

  if (type === 'downloadStarted' || type === 'downloadFailed') {
    // Forward to popup
  }

  // Forward everything to extension runtime
  try { chrome.runtime.sendMessage({ action: 'fromContent', type, data }); } catch(e) {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'toPage') {
    window.postMessage({ source: 'crispExporterCmd', command: message.command, payload: message.payload || {} }, '*');
    sendResponse({ sent: true });
    return true;
  }

  if (message.action === 'getPageInfo') {
    const url = window.location.href;
    const match = url.match(/website\/([a-f0-9-]+)/);
    sendResponse({ url, websiteId: match?.[1] || null, isCrispPage: url.includes('app.crisp.chat') });
    return true;
  }

  if (message.action === 'pingMainWorld') {
    let done = false;
    const handler = (ev) => {
      if (ev.source !== window || !ev.data || ev.data.source !== 'crispExporter' || ev.data.type !== 'pong') return;
      done = true;
      window.removeEventListener('message', handler);
      sendResponse({ alive: true, data: ev.data.data });
    };
    window.addEventListener('message', handler);
    window.postMessage({ source: 'crispExporterCmd', command: 'ping', payload: {} }, '*');
    setTimeout(() => { if (!done) { window.removeEventListener('message', handler); sendResponse({ alive: false }); } }, 2000);
    return true;
  }

  if (message.action === 'domFallbackExport') {
    runDomExport(message.options || {}).then(results => {
      // Forward result to main-world so downloadDirect can find it in CE.lastResult
      window.postMessage({ source: 'crispExporterCmd', command: 'storeResult', payload: { result: results } }, '*');
      chrome.storage.local.set({
        exportInProgress: false, exportHasResult: true,
        exportProgress: { phase: 'complete', statsConv: results.stats.totalConversations,
          statsMsg: results.stats.totalMessages, statsNotes: results.stats.totalNotes },
        exportTimestamp: Date.now()
      });
      try { chrome.runtime.sendMessage({ action: 'fromContent', type: 'exportResult', data: { stats: results.stats } }); } catch(e) {}
    });
    sendResponse({ started: true });
    return true;
  }
});

async function runDomExport(options) {
  const results = { conversations:[], errors:[], stats:{ totalConversations:0, totalMessages:0, totalNotes:0, exportedAt:new Date().toISOString() } };
  const links = Array.from(document.querySelectorAll('a[href]')).filter(a => /\/inbox\/[a-f0-9-]{20,}/.test(a.getAttribute('href')||''));
  if (!links.length) return results;
  results.stats.totalConversations = links.length;
  for (let i = 0; i < links.length; i++) {
    const href = links[i].getAttribute('href')||'';
    const sid = href.match(/inbox\/([a-f0-9-]+)/)?.[1]||'unknown-'+i;
    const name = links[i].textContent?.trim()?.split('\n')[0]?.substring(0,80)||'Unknown';
    try {
      links[i].click(); await new Promise(r=>setTimeout(r,1500));
      const msgEls = document.querySelectorAll('[class*="message"],[class*="Message"],[class*="bubble"]');
      const messages = [];
      msgEls.forEach(m => { const t=m.textContent?.trim(); if(!t||t.length<2)return;
        const cls=(m.className||'')+' '+(m.parentElement?.className||'');
        messages.push({ from:/operator|agent/i.test(cls)?'operator':/visitor|user/i.test(cls)?'user':'unknown',
          fromName:'', content:t.substring(0,10000), timestamp:'', isNote:/note|private/i.test(cls), type:'text', isAutomated:false }); });
      results.stats.totalMessages += messages.length;
      results.conversations.push({ sessionId:sid, visitorName:name, operatorNames:['Unknown'], status:'unknown', createdAt:'', messages, messageCount:messages.length, noteCount:messages.filter(m=>m.isNote).length });
    } catch(e) { results.errors.push({ sessionId:sid, visitor:name, error:e.message }); }
    chrome.storage.local.set({ exportProgress:{ phase:'fetching', total:links.length, done:i+1, current:name }, exportInProgress:true, exportTimestamp:Date.now() });
  }
  return results;
}

console.log('[Crisp Exporter] Content script loaded');
