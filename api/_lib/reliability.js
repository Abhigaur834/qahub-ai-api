/**
 * QA.Hub — Shared reliability helpers
 *
 * withRetry(): retries a transient-failure-prone async operation with
 * exponential backoff. Use around single external API calls (Deepgram,
 * Gemini, Smartflo) — not around the whole request handler, since Vercel
 * functions have a hard maxDuration and retrying the *entire* pipeline
 * in-process risks timing out instead of failing cleanly.
 *
 * sendFailureAlert(): fires a best-effort email (via Resend, same pattern
 * as notify-agent.js) to an admin address when a call permanently fails
 * after retries are exhausted. Silently skips if RESEND_API_KEY or
 * ADMIN_ALERT_EMAIL aren't set — never throws, never blocks the caller.
 */

// Pulls a suggested wait time out of a 429 rate-limit error, if the API
// told us one. Handles Gemini's plain-text "Please retry in 23.9s" style
// as well as a numeric retryAfterMs already attached to the error object.
function getSuggestedDelayMs(error) {
  if (error && typeof error.retryAfterMs === 'number') return error.retryAfterMs;
  const match = (error && error.message || '').match(/retry in ([\d.]+)\s*s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  return null;
}

async function withRetry(fn, { retries = 2, baseDelayMs = 1000, maxDelayMs = 30000, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      const isLastAttempt = attempt === retries;
      const isRateLimit = e && (e.status === 429 || /\b429\b/.test(e.message || ''));
      const suggested = isRateLimit ? getSuggestedDelayMs(e) : null;
      const delay = suggested != null
        ? Math.min(suggested + 500, maxDelayMs) // small buffer past what the API asked for
        : baseDelayMs * Math.pow(2, attempt);     // default exponential backoff: 1s, 2s, 4s...
      console.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}): ${e.message}${isLastAttempt ? ' — giving up' : ` — retrying in ${delay}ms${isRateLimit ? ' (rate limited)' : ''}`}`);
      if (isLastAttempt) break;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function sendFailureAlert({ stage, callKey, processId, errorMessage, agentName, callerNumber }) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_ALERT_EMAIL) {
    console.warn(`sendFailureAlert skipped (RESEND_API_KEY or ADMIN_ALERT_EMAIL not set) — ${stage} failed for ${processId}/${callKey}: ${errorMessage}`);
    return { sent: false, reason: 'not configured' };
  }
  try {
    const APP_BASE = process.env.APP_BASE_URL || 'https://app.qahub.online';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
        <h2 style="margin-bottom:4px;color:#f04060">QA.Hub — Call Permanently Failed</h2>
        <p style="color:#666;font-size:13px">A call exhausted all retries and needs manual attention.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
          <tr><td style="padding:6px 0;color:#888">Stage</td><td style="padding:6px 0;font-weight:700">${escapeHtml(stage)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Process</td><td style="padding:6px 0">${escapeHtml(processId || '—')}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Call Key</td><td style="padding:6px 0">${escapeHtml(callKey || '—')}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Agent</td><td style="padding:6px 0">${escapeHtml(agentName || '—')}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Caller</td><td style="padding:6px 0">${escapeHtml(callerNumber || '—')}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Error</td><td style="padding:6px 0;color:#f04060">${escapeHtml(errorMessage || '—')}</td></tr>
        </table>
        <a href="${APP_BASE}" style="display:inline-block;background:#3d7ef5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700;font-size:13px">Open QA.Hub →</a>
      </div>`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || 'QA.Hub <onboarding@resend.dev>',
        to: [process.env.ADMIN_ALERT_EMAIL],
        subject: `QA.Hub: call failed permanently — ${stage}`,
        html,
      }),
    });
    if (!resendRes.ok) throw new Error(`Resend ${resendRes.status}: ${await resendRes.text()}`);
    return { sent: true };
  } catch (e) {
    console.error('sendFailureAlert: failed to send —', e.message);
    return { sent: false, reason: e.message };
  }
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * waitForGeminiSlot(): a free-tier-friendly traffic light for the Gemini
 * API. Serverless invocations don't share memory, so instead of an
 * in-process rate limiter, each call atomically claims the next
 * available time slot in Firebase (via a transaction) and waits until
 * its turn. This spaces out concurrent calls — e.g. an 8-call upload
 * burst — so they hit Gemini one at a time, roughly minIntervalMs apart,
 * instead of all at once tripping a per-minute quota.
 *
 * This smooths out normal bursts; it is not a substitute for a paid
 * quota if sustained volume genuinely exceeds what pacing can absorb
 * within a single function's execution window.
 */
async function waitForGeminiSlot(db, { minIntervalMs = 3200, maxWaitMs = 45000 } = {}) {
  const rateRef = db.ref('rateLimiter/geminiNextSlot');
  const txResult = await rateRef.transaction(current => {
    const now = Date.now();
    const prevSlot = (typeof current === 'number') ? current : 0;
    const base = Math.max(prevSlot, now);
    return base + minIntervalMs;
  });
  const committedNextSlot = txResult.snapshot.val();
  const mySlot = committedNextSlot - minIntervalMs;
  const waitMs = Math.min(Math.max(0, mySlot - Date.now()), maxWaitMs);
  if (waitMs > 0) {
    console.warn(`waitForGeminiSlot: pacing — waiting ${waitMs}ms before calling Gemini`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

module.exports = { withRetry, sendFailureAlert, waitForGeminiSlot };
