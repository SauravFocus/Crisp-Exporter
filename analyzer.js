(function () {
  'use strict';

  // ── Stop words ────────────────────────────────────────────────────────────
  const STOP_WORDS = new Set([
    'a','an','the','and','or','but','if','in','on','at','to','for','of','with',
    'by','from','as','is','was','are','were','be','been','being','have','has',
    'had','do','does','did','will','would','could','should','may','might','shall',
    'can','not','no','nor','so','yet','both','either','neither','just','than',
    'that','this','these','those','it','its','i','me','my','myself','we','our',
    'you','your','he','his','she','her','they','their','them','us','who','which',
    'what','how','when','where','why','all','any','each','every','some','more',
    'also','about','up','out','there','here','then','now','after','before','into',
    'over','under','between','through','during','without','within','against',
    'very','too','much','many','only','other','well','still','back','own','same',
    'hi','hello','hey','thanks','thank','please','help','need','want','know',
    'get','got','getting','see','use','using','used','try','tried','make','made',
    'work','working','works','worked','let','going','like','really','able','seem',
    'seems','thing','things','way','even','said','something','anything','everything',
    'nothing','one','two','three','new','good','great','ok','okay','yes','sure',
    'time','day','days','week','month','re','ve','ll','don','isn','wasn','can',
    'couldn','won','wouldn','didn','doesn','hadn','hasn','haven',
  ]);

  const CHUNK_SIZE = 250;
  const DOW_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  let currentData = null;

  // ── Init ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    bindDropZone();
    bindTabs();
    $('loadNewBtn').addEventListener('click', resetToDropZone);
  });

  // ── Drop zone & file loading ───────────────────────────────────────────────
  function bindDropZone() {
    const zone = $('dropZone');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) onFileSelect(file);
    });
    $('filePicker').addEventListener('change', e => {
      if (e.target.files[0]) onFileSelect(e.target.files[0]);
    });
  }

  function onFileSelect(file) {
    if (!file.name.toLowerCase().endsWith('.json')) {
      showError('Please select a .json file exported by the Crisp Chat Exporter.');
      return;
    }
    hideDropZone();
    showProgressOverlay('Reading file…', 0, file.name);

    const reader = new FileReader();
    reader.onload = async e => {
      let data;
      try {
        showProgressOverlay('Parsing JSON…', 3, '');
        await yieldToUI();
        data = JSON.parse(e.target.result);
      } catch (err) {
        resetToDropZone();
        showError('Invalid JSON: ' + err.message);
        return;
      }
      if (!data || !Array.isArray(data.conversations)) {
        resetToDropZone();
        showError('This does not look like a Crisp Chat Exporter JSON file (missing "conversations" array).');
        return;
      }
      currentData = data;
      await runAnalysis(data);
    };
    reader.onerror = () => { resetToDropZone(); showError('Could not read file.'); };
    reader.readAsText(file, 'utf-8');
  }

  // ── Chunked analysis ──────────────────────────────────────────────────────
  async function runAnalysis(rawData) {
    const convs  = rawData.conversations || [];
    const total  = convs.length;

    const acc = {
      keywordFreq:   new Map(),
      bigramFreq:    new Map(),
      operatorMap:   new Map(),
      statusMap:     new Map(),
      tagFreq:       new Map(),
      hourCounts:    new Array(24).fill(0),
      dowCounts:     new Array(7).fill(0),
      lengthBuckets: { short: 0, medium: 0, long: 0, veryLong: 0 },
      msgTypes:      new Map(),
      totalMessages: 0,
      totalNotes:    0,
      resolvedCount: 0,
      errorConvs:    0,
    };

    if (total === 0) {
      renderDashboard(buildResults(acc, rawData.stats, 0));
      return;
    }

    for (let i = 0; i < total; i += CHUNK_SIZE) {
      processChunk(convs.slice(i, i + CHUNK_SIZE), acc);
      const done = Math.min(i + CHUNK_SIZE, total);
      const pct  = Math.round((done / total) * 90) + 5;
      showProgressOverlay('Analysing conversations…', pct, done + ' / ' + total);
      await yieldToUI();
    }

    showProgressOverlay('Rendering…', 98, '');
    await yieldToUI();
    renderDashboard(buildResults(acc, rawData.stats, total));
  }

  function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

  // ── Per-chunk processing ──────────────────────────────────────────────────
  function processChunk(convs, acc) {
    for (const conv of convs) {
      if (conv.fetchError) acc.errorConvs++;

      // Status
      const status = (conv.status || 'unknown').toLowerCase();
      acc.statusMap.set(status, (acc.statusMap.get(status) || 0) + 1);
      if (status === 'resolved') acc.resolvedCount++;

      // Tags
      for (const tag of (conv.tags || [])) {
        const t = String(tag).toLowerCase().trim();
        if (t) acc.tagFreq.set(t, (acc.tagFreq.get(t) || 0) + 1);
      }

      // Temporal (UTC)
      const createdDate = normalizeTs(conv.createdAt);
      if (createdDate) {
        acc.hourCounts[createdDate.getUTCHours()]++;
        acc.dowCounts[createdDate.getUTCDay()]++;
      }

      // Conversation length bucket
      const mc = conv.messageCount != null ? conv.messageCount : (conv.messages || []).length;
      if      (mc < 5)  acc.lengthBuckets.short++;
      else if (mc <= 20) acc.lengthBuckets.medium++;
      else if (mc <= 50) acc.lengthBuckets.long++;
      else               acc.lengthBuckets.veryLong++;

      // Messages
      const messages = conv.messages || [];
      acc.totalMessages += messages.length;
      acc.totalNotes    += conv.noteCount != null ? conv.noteCount : messages.filter(m => m.isNote).length;

      let firstOpTs = null;

      for (const msg of messages) {
        // Message type
        let typeKey;
        if (msg.isNote || msg.type === 'note')     typeKey = 'note';
        else if (msg.isAutomated)                  typeKey = 'automated';
        else if (msg.type === 'file')              typeKey = 'file';
        else if (!msg.type || msg.type === 'text') typeKey = 'text';
        else                                       typeKey = msg.type;
        acc.msgTypes.set(typeKey, (acc.msgTypes.get(typeKey) || 0) + 1);

        // First operator response
        if (msg.from === 'operator' && !msg.isAutomated && firstOpTs === null) {
          const d = normalizeTs(msg.timestamp);
          if (d) firstOpTs = d.getTime();
        }
      }

      // Operator stats
      for (const opName of (conv.operatorNames || [])) {
        if (!opName || opName === 'Unassigned') continue;
        if (!acc.operatorMap.has(opName)) {
          acc.operatorMap.set(opName, {
            convCount: 0, msgCount: 0, noteCount: 0,
            firstRespDelays: [], convMsgCounts: [],
          });
        }
        const op = acc.operatorMap.get(opName);
        op.convCount++;
        op.convMsgCounts.push(mc);

        for (const msg of messages) {
          if (msg.from === 'operator' || msg.fromName === opName) {
            if (msg.isNote) op.noteCount++;
            else op.msgCount++;
          }
        }

        if (firstOpTs !== null && conv.createdAt) {
          const convStart = normalizeTs(conv.createdAt);
          if (convStart) {
            const delaySec = Math.max(0, (firstOpTs - convStart.getTime()) / 1000);
            op.firstRespDelays.push(delaySec);
          }
        }
      }

      // Keywords — first visitor text message
      const firstVisMsg = messages.find(
        m => m.from === 'visitor' && !m.isAutomated && m.type !== 'file'
      );
      if (firstVisMsg) {
        const tokens = tokenize(firstVisMsg.content || '');
        for (const t of tokens)              acc.keywordFreq.set(t, (acc.keywordFreq.get(t) || 0) + 1);
        for (const bg of extractBigrams(tokens)) acc.bigramFreq.set(bg, (acc.bigramFreq.get(bg) || 0) + 1);
      }
    }
  }

  // ── Build final results object ────────────────────────────────────────────
  function buildResults(acc, exportStats, total) {
    const operators = [];
    for (const [name, op] of acc.operatorMap) {
      const avgDelay = op.firstRespDelays.length
        ? op.firstRespDelays.reduce((a, b) => a + b, 0) / op.firstRespDelays.length
        : null;
      const avgLen = op.convMsgCounts.length
        ? op.convMsgCounts.reduce((a, b) => a + b, 0) / op.convMsgCounts.length
        : 0;
      operators.push({ name, convCount: op.convCount, msgCount: op.msgCount,
        noteCount: op.noteCount, avgDelaySec: avgDelay, avgConvLength: avgLen });
    }
    operators.sort((a, b) => b.convCount - a.convCount);

    return {
      summary: {
        totalConversations: total,
        totalMessages:      acc.totalMessages,
        totalNotes:         acc.totalNotes,
        avgMsgPerConv:      total ? acc.totalMessages / total : 0,
        avgNotesPerConv:    total ? acc.totalNotes / total : 0,
        pctResolved:        total ? acc.resolvedCount / total * 100 : 0,
        pctWithErrors:      total ? acc.errorConvs / total * 100 : 0,
        exportedAt:         exportStats?.exportedAt || null,
      },
      keywords: {
        unigrams: topN(acc.keywordFreq, 30),
        bigrams:  topN(acc.bigramFreq, 20),
      },
      operators,
      status:   topN(acc.statusMap, 20),
      tags:     topN(acc.tagFreq, 25),
      temporal: { hourCounts: acc.hourCounts, dowCounts: acc.dowCounts },
      length:   acc.lengthBuckets,
      msgTypes: topN(acc.msgTypes, 10),
    };
  }

  // ── Keyword helpers ───────────────────────────────────────────────────────
  function tokenize(text) {
    return text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, '')
      .replace(/[^a-z\s'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t) && !/^[-']+$/.test(t));
  }

  function extractBigrams(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length - 1; i++) out.push(tokens[i] + ' ' + tokens[i + 1]);
    return out;
  }

  function topN(freqMap, n) {
    return [...freqMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([label, count]) => ({ label, count }));
  }

  // ── Timestamp normalization ───────────────────────────────────────────────
  function normalizeTs(ts) {
    if (ts == null) return null;
    if (typeof ts === 'number') return ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }

  // ── Duration formatter ────────────────────────────────────────────────────
  function fmtDuration(sec) {
    if (sec === null) return '—';
    if (sec < 60)    return Math.round(sec) + 's';
    if (sec < 3600)  return Math.round(sec / 60) + 'm';
    if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
    return (sec / 86400).toFixed(1) + 'd';
  }

  // ── HTML escape ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function renderDashboard(results) {
    hideProgressOverlay();

    renderSummary(results.summary);
    renderBarChart('keywordsUni', results.keywords.unigrams, {});
    renderBarChart('keywordsBi',  results.keywords.bigrams,  {});
    renderOperatorTable(results.operators);
    renderBarChart('statusChart', results.status, {
      showPct: true, total: results.summary.totalConversations,
      colorFn: statusColor,
    });
    renderBarChart('tagsChart', results.tags, {
      showPct: true, total: results.summary.totalConversations,
    });
    renderHourChart(results.temporal.hourCounts);
    renderDowChart(results.temporal.dowCounts);
    renderBarChart('lengthChart', [
      { label: 'Short (< 5 msgs)',   count: results.length.short    },
      { label: 'Medium (5–20 msgs)', count: results.length.medium   },
      { label: 'Long (21–50 msgs)',  count: results.length.long     },
      { label: 'Very Long (> 50)',   count: results.length.veryLong },
    ].filter(r => r.count > 0), { showPct: true, total: results.summary.totalConversations });
    renderBarChart('msgTypeChart', results.msgTypes, {
      showPct: true, total: results.summary.totalMessages || 1,
    });

    bindTabs();
    $('dashboard').style.display = 'block';
    $('loadNewBtn').style.display = 'inline-flex';
  }

  function renderSummary(s) {
    const strip = $('summaryStrip');
    const fmt = n => Number.isFinite(n) ? (n % 1 === 0 ? n.toLocaleString() : n.toFixed(1)) : '—';
    const pct  = n => Number.isFinite(n) ? n.toFixed(1) + '%' : '—';
    const pills = [
      { label: 'Conversations',     value: fmt(s.totalConversations) },
      { label: 'Messages',          value: fmt(s.totalMessages)      },
      { label: 'Notes',             value: fmt(s.totalNotes)         },
      { label: 'Avg Msgs / Conv',   value: fmt(s.avgMsgPerConv)      },
      { label: 'Avg Notes / Conv',  value: fmt(s.avgNotesPerConv)    },
      { label: 'Resolved',          value: pct(s.pctResolved)        },
      { label: 'Fetch Errors',      value: pct(s.pctWithErrors)      },
      { label: 'Exported At',       value: s.exportedAt ? new Date(s.exportedAt).toLocaleDateString() : '—' },
    ];
    strip.innerHTML = pills.map(p =>
      `<div class="stat-pill">
        <span class="stat-pill-value">${esc(p.value)}</span>
        <span class="stat-pill-label">${esc(p.label)}</span>
      </div>`
    ).join('');
  }

  function renderBarChart(containerId, items, opts) {
    const el = $(containerId);
    if (!el) return;
    if (!items || items.length === 0) {
      el.innerHTML = '<p class="empty-state">No data</p>';
      return;
    }
    const maxCount = items[0].count;
    const showPct  = opts.showPct || false;
    const total    = opts.total   || null;
    const colorFn  = opts.colorFn || (() => 'var(--accent)');
    const frag     = document.createDocumentFragment();

    for (const { label, count } of items) {
      const pct     = maxCount ? (count / maxCount) * 100 : 0;
      const display = (showPct && total)
        ? count.toLocaleString() + ' (' + Math.round(count / total * 100) + '%)'
        : count.toLocaleString();

      const row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = `
        <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${colorFn(label)}"></div>
        </div>
        <span class="bar-count">${esc(display)}</span>`;
      frag.appendChild(row);
    }
    el.innerHTML = '';
    el.appendChild(frag);
  }

  function statusColor(status) {
    const s = String(status).toLowerCase();
    if (s === 'resolved')                            return 'var(--success)';
    if (s === 'pending')                             return 'var(--warning)';
    if (s.includes('unresolved') || s === 'open')   return 'var(--error)';
    return 'var(--accent)';
  }

  function renderOperatorTable(operators) {
    const el = $('operatorTable');
    if (!el) return;
    if (!operators.length) {
      el.parentElement.innerHTML = '<p class="empty-state">No operator data</p>';
      return;
    }
    const headers = ['Operator','Conversations','Messages (approx)','Notes','Avg First Response','Avg Conv Length'];
    let html = '<thead><tr>' + headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>';
    for (const op of operators) {
      html += `<tr>
        <td class="op-name">${esc(op.name)}</td>
        <td>${op.convCount.toLocaleString()}</td>
        <td>${op.msgCount.toLocaleString()}</td>
        <td>${op.noteCount.toLocaleString()}</td>
        <td>${fmtDuration(op.avgDelaySec)}</td>
        <td>${op.avgConvLength.toFixed(1)}</td>
      </tr>`;
    }
    html += '</tbody>';
    el.innerHTML = html;
  }

  function renderHourChart(hourCounts) {
    const el = $('hourChart');
    if (!el) return;
    el.innerHTML = '';
    const maxVal = Math.max(...hourCounts, 1);
    for (let h = 0; h < 24; h++) {
      const val       = hourCounts[h];
      const heightPct = (val / maxVal) * 100;
      const showLabel = h % 6 === 0;
      const wrap      = document.createElement('div');
      wrap.className  = 'hour-bar-wrap';
      wrap.title      = h + ':00 UTC — ' + val.toLocaleString() + ' conversations';
      wrap.innerHTML  = `
        <div class="hour-bar" style="height:${heightPct.toFixed(1)}%"></div>
        <span class="hour-label">${showLabel ? h : ''}</span>`;
      el.appendChild(wrap);
    }
  }

  function renderDowChart(dowCounts) {
    const items = DOW_LABELS.map((label, i) => ({ label, count: dowCounts[i] }));
    renderBarChart('dowChart', items, {});
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  function bindTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        btn.closest('.tab-row').querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        btn.closest('.panel').querySelectorAll('.chart-container[data-tab]').forEach(c => {
          c.style.display = c.id === targetId ? 'block' : 'none';
        });
      });
    });
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  function showProgressOverlay(msg, pct, sub) {
    $('progressOverlay').style.display = 'flex';
    $('progressMsg').textContent = msg;
    $('progressBar').style.width = pct + '%';
    $('progressSub').textContent = sub;
  }

  function hideProgressOverlay() {
    $('progressOverlay').style.display = 'none';
  }

  function hideDropZone() {
    $('dropZone').style.display = 'none';
  }

  function resetToDropZone() {
    currentData = null;
    $('filePicker').value = '';
    $('dashboard').style.display = 'none';
    $('progressOverlay').style.display = 'none';
    $('loadNewBtn').style.display = 'none';
    $('dropZone').style.display = 'flex';
    $('errorBanner').style.display = 'none';
  }

  function showError(msg) {
    const el = $('errorBanner');
    el.textContent = msg;
    el.style.display = 'block';
  }

})();
