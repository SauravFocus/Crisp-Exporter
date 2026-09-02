/**
 * Crisp Chat Exporter — Popup
 * 
 * Downloads happen in the PAGE context (main-world.js) via the
 * 'downloadDirect' command. This avoids chrome.storage size limits entirely.
 * Popup only reads small progress objects from chrome.storage.
 */

let state = { tabId: null, websiteId: null, inboxFilter: null, exporting: false, hasResult: false, pollTimer: null, pendingAutoDownload: false };
const $ = sel => document.querySelector(sel);
const els = {};

document.addEventListener('DOMContentLoaded', init);

function cacheEls() {
  ['connectionStatus','notCrispWarning','websiteInfo','websiteIdDisplay','visibleCount',
   'inboxFilterCard','useInboxFilter','inboxFilterLabel',
   'filtersSection','filtersToggle','filtersPanel','filterStatus','filterDateFrom','filterDateTo',
   'formatSection','exportSection','exportBtn','progressSection','progressLabel','progressPercent',
   'progressFill','progressDetail','cancelBtn','resultsSection','statConversations','statMessages',
   'statNotes','errorSummary','errorCount','errorDetails','showErrorsBtn','downloadBtn','newExportBtn',
   'chunkSize','splitBtn','splitStatus','analyzeBtn'
  ].forEach(id => els[id] = $('#'+id));
  els.statusDot = els.connectionStatus?.querySelector('.status-dot');
  els.statusText = els.connectionStatus?.querySelector('.status-text');
}

async function init() {
  cacheEls();

  try {
    const p = await chrome.storage.local.get(['format','status','dateFrom','dateTo']);
    if (p.format) { const r=$(`input[name="format"][value="${p.format}"]`); if(r) r.checked=true; }
    if (p.status&&els.filterStatus) els.filterStatus.value=p.status;
    if (p.dateFrom&&els.filterDateFrom) els.filterDateFrom.value=p.dateFrom;
    if (p.dateTo&&els.filterDateTo) els.filterDateTo.value=p.dateTo;
  } catch(e){}

  chrome.runtime.onMessage.addListener(handleContentMessage);
  bindEvents();
  await checkCurrentTab();

  // Check stored state
  const stored = await chrome.storage.local.get(['exportInProgress','exportProgress','exportHasResult','exportTimestamp']);
  const age = Date.now() - (stored.exportTimestamp||0);
  const resultRecent = age < 24 * 60 * 60 * 1000; // 24h — match IndexedDB TTL
  const progressRecent = age < 8 * 60 * 60 * 1000; // 8h — covers longest realistic exports

  if (resultRecent && stored.exportHasResult && stored.exportProgress?.phase==='complete') {
    state.hasResult = true;
    showResultsFromProgress(stored.exportProgress);
    return;
  }

  if (progressRecent && stored.exportInProgress) {
    state.exporting = true;
    showProgress();
    applyProgress(stored.exportProgress);
    startPolling();
    return;
  }
}

async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    if (!tab||!(tab.url||'').includes('app.crisp.chat')) { showNotCrisp(); return; }
    state.tabId = tab.id;
    const match = (tab.url||'').match(/website\/([a-f0-9-]+)/);
    if (match) state.websiteId = match[1];

    try {
      const info = await sendToContentScript({ action:'getPageInfo' });
      if (info?.websiteId) state.websiteId = info.websiteId;
    } catch(e) {
      try {
        await chrome.scripting.executeScript({ target:{tabId:state.tabId}, files:['content.js'] });
        await delay(500);
        const info = await sendToContentScript({ action:'getPageInfo' });
        if (info?.websiteId) state.websiteId = info.websiteId;
      } catch(e2){}
    }

    let mainAlive = false;
    try {
      const ping = await sendToContentScript({ action:'pingMainWorld' });
      mainAlive = ping?.alive||false;
      state.inboxFilter = ping?.data?.inboxFilter||null;
    } catch(e){}
    if (!mainAlive) {
      try { await chrome.scripting.executeScript({ target:{tabId:state.tabId}, files:['main-world.js'], world:'MAIN' }); await delay(800); mainAlive=true; } catch(e){}
    }

    showConnected(mainAlive);
  } catch(e) { showNotCrisp(); }
}

// ── Polling ──
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const s = await chrome.storage.local.get(['exportInProgress','exportProgress','exportHasResult','exportTimestamp']);

      if (s.exportHasResult && s.exportProgress?.phase==='complete') {
        stopPolling(); state.exporting=false; state.hasResult=true;
        showResultsFromProgress(s.exportProgress);
        if (state.pendingAutoDownload) {
          state.pendingAutoDownload = false;
          const fmt = $('input[name="format"]:checked')?.value || 'json';
          sendToPage('downloadDirect', { format: fmt });
          if(els.downloadBtn) els.downloadBtn.textContent = 'Download Again';
        }
        return;
      }
      if (!s.exportInProgress && s.exportProgress?.phase==='error') {
        stopPolling(); state.exporting=false;
        updateProgress(s.exportProgress.message||'Export failed', 0);
        if(els.cancelBtn) els.cancelBtn.textContent='Back';
        return;
      }
      if (!s.exportInProgress && s.exportProgress?.phase==='cancelled') {
        stopPolling(); state.exporting=false; resetToReady(); return;
      }
      if (s.exportProgress) applyProgress(s.exportProgress);
    } catch(e){}
  }, 1000);
}
function stopPolling() { if(state.pollTimer){clearInterval(state.pollTimer);state.pollTimer=null;} }

function applyProgress(data) {
  if (!data) return;
  if (data.phase==='starting') updateProgress(data.message||'Starting…',0);
  else if (data.phase==='listing') updateProgress('Finding conversations…',5,'Found '+(data.count||0)+' so far');
  else if (data.phase==='fetching'&&data.total) {
    const done=data.done||0;
    updateProgress('Exporting ('+done+'/'+data.total+')', 10+(done/data.total)*88, data.current?'Current: '+data.current:'');
  }
  else if (data.phase==='complete') updateProgress('Export complete!',100);
  else if (data.phase==='error') updateProgress('Error',null,data.message);
}

// ── UI ──
function showNotCrisp() {
  setStatus('error','Not connected');
  show(els.notCrispWarning); hide(els.websiteInfo); hide(els.inboxFilterCard); hide(els.filtersSection); hide(els.formatSection); hide(els.exportSection);
}
function showConnected(mainAlive) {
  setStatus('connected','Connected');
  hide(els.notCrispWarning); show(els.websiteInfo); show(els.filtersSection); show(els.formatSection); show(els.exportSection);
  if(els.websiteIdDisplay) els.websiteIdDisplay.textContent=state.websiteId||'detecting…';
  if(els.visibleCount) els.visibleCount.textContent=mainAlive?'API ready':'DOM mode';
  renderInboxFilter();
}
function renderInboxFilter() {
  if(!els.inboxFilterCard) return;
  if(!state.inboxFilter) { hide(els.inboxFilterCard); return; }
  if(els.inboxFilterLabel) els.inboxFilterLabel.textContent=state.inboxFilter;
  show(els.inboxFilterCard);
}
function setStatus(type,text) {
  if(els.connectionStatus) els.connectionStatus.className='status-badge status-'+type;
  if(els.statusText) els.statusText.textContent=text;
}
function show(el){if(el)el.style.display='flex';}
function hide(el){if(el)el.style.display='none';}
function showProgress() {
  hide(els.exportSection);hide(els.inboxFilterCard);hide(els.filtersSection);hide(els.formatSection);hide(els.resultsSection);
  show(els.progressSection);
  if(els.cancelBtn) els.cancelBtn.textContent='Cancel';
}
function resetToReady() {
  hide(els.progressSection);hide(els.resultsSection);
  renderInboxFilter();
  show(els.filtersSection);show(els.formatSection);show(els.exportSection);
  if(els.exportBtn) els.exportBtn.disabled=false;
  if(els.downloadBtn) els.downloadBtn.textContent='Download File';
  if(els.splitStatus) els.splitStatus.style.display='none';
  state.exporting=false; state.hasResult=false; state.pendingAutoDownload=false; stopPolling();
  chrome.storage.local.remove(['exportInProgress','exportProgress','exportHasResult','exportTimestamp']);
}
function updateProgress(label,percent,detail) {
  if(els.progressLabel) els.progressLabel.textContent=label;
  if(percent!=null){
    if(els.progressPercent) els.progressPercent.textContent=Math.round(percent)+'%';
    if(els.progressFill) els.progressFill.style.width=percent+'%';
  }
  if(detail&&els.progressDetail) els.progressDetail.textContent=detail;
}
function showResultsFromProgress(prog) {
  if(els.statConversations) els.statConversations.textContent=prog.statsConv||0;
  if(els.statMessages) els.statMessages.textContent=prog.statsMsg||0;
  if(els.statNotes) els.statNotes.textContent=prog.statsNotes||0;
  if(prog.errorCount>0) {
    show(els.errorSummary);
    if(els.errorCount) els.errorCount.textContent=prog.errorCount;
    if(els.errorDetails && prog.errors?.length) {
      els.errorDetails.innerHTML = prog.errors.map(e =>
        `<div>${e.visitor||e.sessionId||'Unknown'}: ${e.error||'Unknown error'}</div>`
      ).join('');
    }
  } else { hide(els.errorSummary); }
  hide(els.progressSection);hide(els.exportSection);hide(els.inboxFilterCard);hide(els.filtersSection);hide(els.formatSection);
  show(els.resultsSection);
}

// ── Events ──
function bindEvents() {
  els.filtersToggle?.addEventListener('click',()=>{
    if(!els.filtersPanel)return;
    const open=els.filtersPanel.style.display!=='none';
    els.filtersPanel.style.display=open?'none':'flex';
    els.filtersToggle?.classList.toggle('open',!open);
  });
  els.filterStatus?.addEventListener('change',savePrefs);
  els.filterDateFrom?.addEventListener('change',savePrefs);
  els.filterDateTo?.addEventListener('change',savePrefs);
  document.querySelectorAll('input[name="format"]').forEach(r=>r.addEventListener('change',savePrefs));

  els.exportBtn?.addEventListener('click',startExport);
  els.cancelBtn?.addEventListener('click',()=>{
    sendToPage('cancelExport');
    state.exporting=false; stopPolling();
    chrome.storage.local.set({exportInProgress:false,exportProgress:{phase:'cancelled'}});
    resetToReady();
  });

  // ★ Download happens in page context — NOT via chrome.downloads
  els.downloadBtn?.addEventListener('click',()=>{
    const format = $('input[name="format"]:checked')?.value||'json';
    sendToPage('downloadDirect', { format });
  });

  els.analyzeBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('analyzer.html') });
  });
  els.newExportBtn?.addEventListener('click',resetToReady);
  els.showErrorsBtn?.addEventListener('click',()=>{
    if(els.errorDetails) els.errorDetails.style.display=els.errorDetails.style.display!=='none'?'none':'block';
  });
  els.splitBtn?.addEventListener('click',()=>{
    const chunkSize=parseInt(els.chunkSize?.value)||100;
    if(els.splitStatus){els.splitStatus.textContent='Preparing chunks…'; els.splitStatus.style.display='block';}
    sendToPage('splitForClaude',{chunkSize});
  });
}
function savePrefs() {
  chrome.storage.local.set({
    format:$('input[name="format"]:checked')?.value||'csv',
    status:els.filterStatus?.value||'all',
    dateFrom:els.filterDateFrom?.value||'',
    dateTo:els.filterDateTo?.value||''
  });
}

async function startExport() {
  if(state.exporting)return;
  if(!state.websiteId){alert('Could not detect Website ID. Navigate to your Crisp inbox.');return;}
  state.exporting=true; state.hasResult=false; state.pendingAutoDownload=true;
  if(els.exportBtn) els.exportBtn.disabled=true;
  chrome.storage.local.set({exportInProgress:true,exportHasResult:false,exportProgress:{phase:'starting',message:'Initializing...'},exportTimestamp:Date.now()});
  showProgress();
  updateProgress('Initializing export…',0);
  const options={status:els.filterStatus?.value||'all',dateFrom:els.filterDateFrom?.value||null,dateTo:els.filterDateTo?.value||null,
    useInboxFilter:els.useInboxFilter?.checked!==false};
  sendToPage('startExport',{websiteId:state.websiteId,options});
  startPolling();
}

function handleContentMessage(message) {
  if(message.action!=='fromContent')return;
  const{type,data}=message;
  if(type==='progress') applyProgress(data);
  if(type==='exportResult') { stopPolling(); state.exporting=false; state.hasResult=true; showResultsFromProgress({ statsConv:data.stats?.totalConversations, statsMsg:data.stats?.totalMessages, statsNotes:data.stats?.totalNotes, errorCount:data.errorCount||0, errors:data.errors||[] }); if(state.pendingAutoDownload){state.pendingAutoDownload=false; const fmt=$('input[name="format"]:checked')?.value||'json'; sendToPage('downloadDirect',{format:fmt}); if(els.downloadBtn)els.downloadBtn.textContent='Download Again';} }
  if(type==='splitComplete') { if(els.splitStatus){els.splitStatus.style.display='block'; els.splitStatus.textContent=data.totalChunks>0?`${data.totalChunks} chunk file${data.totalChunks!==1?'s':''} downloaded.`:'No data to split.';} }
  if(type==='exportError') { stopPolling(); state.exporting=false; updateProgress('Export failed',0,data?.error); if(els.cancelBtn)els.cancelBtn.textContent='Back'; }
  if(type==='downloadStarted') { if(els.progressDetail) els.progressDetail.textContent='Download started: '+(data?.filename||''); }
  if(type==='downloadFailed') { alert('Download failed: '+(data?.error||'Unknown error')); }
  if(type==='needDomFallback') {
    updateProgress('API unavailable, trying DOM…',0);
    sendToContentScript({action:'domFallbackExport',options:{status:els.filterStatus?.value||'all',dateFrom:els.filterDateFrom?.value||null,dateTo:els.filterDateTo?.value||null}}).catch(()=>{});
  }
}

function delay(ms){return new Promise(r=>setTimeout(r,ms));}
function sendToContentScript(msg){return new Promise((res,rej)=>{if(!state.tabId){rej(new Error('No tab'));return;}chrome.tabs.sendMessage(state.tabId,msg,r=>chrome.runtime.lastError?rej(new Error(chrome.runtime.lastError.message)):res(r));});}
function sendToPage(cmd,payload){return sendToContentScript({action:'toPage',command:cmd,payload:payload||{}}).catch(e=>console.warn('sendToPage:',e));}
