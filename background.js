/**
 * Crisp Chat Exporter — Background Service Worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fromContent' && message.type === 'exportResult') {
    // Only store small stats, NOT the full data
    chrome.storage.local.set({
      exportInProgress: false,
      exportHasResult: true,
      exportProgress: { phase: 'complete', statsConv: message.data?.stats?.totalConversations,
        statsMsg: message.data?.stats?.totalMessages, statsNotes: message.data?.stats?.totalNotes,
        errorCount: message.data?.errorCount || 0 },
      exportTimestamp: Date.now()
    });
  }
});
