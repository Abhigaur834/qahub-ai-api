const { withRetry } = require('./_lib/reliability');

module.exports = async function exportAuditToGoogleSheet({ audit, call, processId, callKey, agentProfile }) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) return { synced: false, skipped: true, reason: 'GOOGLE_SHEETS_WEBHOOK_URL not configured' };

  const scores = audit.scores || {};
  const failedCritical = Object.entries(scores)
    .filter(([key, value]) => /^cr/i.test(key) && value === 'no')
    .map(([key]) => key)
    .join(', ');
  const failedNonCritical = Object.entries(scores)
    .filter(([key, value]) => /^nc/i.test(key) && value === 'no')
    .map(([key]) => key)
    .join(', ');
  const coaching = Array.isArray(audit.coachingTips) ? audit.coachingTips.join(' | ') : String(audit.coachingTips || '');

  const payload = {
    date: audit.callDate || audit.date || new Date().toISOString(),
    agentName: audit.agent || call?.agentName || agentProfile?.name || '',
    tlName: audit.tlName || call?.tlName || call?.tl || agentProfile?.tl || '',
    customerNo: call?.callerNumber || call?.customerNumber || audit.customerNo || '',
    recording: call?.recordingUrl || audit.recordingUrl || '',
    qualityScore: audit.totalScore ?? audit.ncScore ?? null,
    summary: audit.summary || audit.callSummary || '',
    criticalParameters: audit.crFatal ? (failedCritical || 'FATAL FAIL') : (failedCritical || 'All critical parameters passed'),
    nonCriticalParameters: failedNonCritical || 'All applicable non-critical parameters passed',
    coachingSuggestions: coaching || audit.recommendation || '',
    feedbackGiven: audit.feedbackGiven || 'AI Audit',
    remarks: audit.observations || audit.remarks || audit.recommendation || '',
    processId,
    callKey,
    source: 'QA.Hub AI Audit',
  };

  const response = await withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      return await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }, { retries: 1, baseDelayMs: 1000, maxDelayMs: 5000, label: 'Google Sheets export' });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Google Sheets export failed (${response.status}): ${text.slice(0, 250)}`);
  }
  return { synced: true };
};
