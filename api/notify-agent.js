/**
 * QA.Hub — Agent Audit Notifications
 *
 * Called by the dashboard right after every audit is saved. Emails the
 * agent their full result — score, which parameters failed, observations,
 * and the coaching recommendation.
 *
 * Uses Resend (https://resend.com) — set RESEND_API_KEY. If that env var
 * isn't set yet, this simply skips sending (not an error) so the rest of
 * the app is unaffected.
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    agentName, agentEmail,
    processId, totalScore, result, crFatal,
    failedParams, observations, recommendation,
    callDate, reviewer,
  } = req.body || {};

  if (!agentName) return res.status(400).json({ error: 'agentName required' });

  const outcome = { email: 'skipped' };

  // ── Email (Resend) ────────────────────────────────────────────────────
  if (process.env.RESEND_API_KEY && agentEmail) {
    try {
      const scoreColor = crFatal ? '#f04060' : totalScore >= 85 ? '#22d38a' : totalScore >= 70 ? '#f08040' : '#f04060';
      const resultLabel = crFatal ? 'FAIL (Critical)' : (result || '—');
      const failedList = (failedParams && failedParams.length)
        ? `<ul style="margin:8px 0;padding-left:20px;color:#444">${failedParams.map(p => `<li style="margin-bottom:4px">${escapeHtml(p)}</li>`).join('')}</ul>`
        : '<p style="color:#777;font-size:13px">No parameters failed.</p>';

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
          <h2 style="margin-bottom:4px">Call Audit Result</h2>
          <p style="color:#666;font-size:13px;margin-top:0">Process: ${escapeHtml(processId || '')} &middot; Call Date: ${escapeHtml(callDate || '—')} &middot; Audited by: ${escapeHtml(reviewer || '—')}</p>
          <div style="background:#f7f7f9;border-radius:10px;padding:18px 20px;margin:16px 0">
            <div style="font-size:13px;color:#666;text-transform:uppercase;letter-spacing:1px">Overall Score</div>
            <div style="font-size:34px;font-weight:800;color:${scoreColor}">${crFatal ? '0' : (totalScore ?? '—')}%</div>
            <div style="font-size:13px;font-weight:700;color:${scoreColor}">${escapeHtml(resultLabel)}</div>
          </div>
          <h3 style="margin-bottom:6px;font-size:15px">Parameters that didn't pass</h3>
          ${failedList}
          ${observations ? `<h3 style="margin-bottom:6px;font-size:15px">Observations</h3><p style="color:#444;font-size:13px;line-height:1.6">${escapeHtml(observations)}</p>` : ''}
          ${recommendation ? `<h3 style="margin-bottom:6px;font-size:15px">Coaching Recommendation</h3><p style="color:#444;font-size:13px;line-height:1.6">${escapeHtml(recommendation)}</p>` : ''}
          <p style="color:#999;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">This is an automated message from QA.Hub. Speak with your Team Leader if you have questions about this audit.</p>
        </div>`;

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'QA.Hub <onboarding@resend.dev>',
          to: [agentEmail],
          subject: `Your call audit result — ${crFatal ? 'FAIL' : (totalScore ?? '—') + '%'}`,
          html,
        }),
      });

      if (!resendRes.ok) throw new Error(`Resend ${resendRes.status}: ${await resendRes.text()}`);
      outcome.email = 'sent';
    } catch (e) {
      console.error('Email send failed:', e);
      outcome.email = 'failed: ' + e.message;
    }
  } else if (!agentEmail) {
    outcome.email = 'skipped: no email on file for this agent';
  }

  return res.status(200).json({ success: true, outcome });
};

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports.config = { maxDuration: 30 };
