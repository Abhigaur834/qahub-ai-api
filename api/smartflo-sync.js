/**
 * QA.Hub — Smartflo (Tata Tele CloudPhone) Call Sync
 *
 * Logs into Smartflo server-side (credentials never touch the browser),
 * pulls recent call records for a date range, and returns the ones that
 * have a recording — including the pre-authorized recording_url that
 * works without being logged into the Smartflo portal.
 *
 * Requires these Vercel environment variables:
 *   SMARTFLO_EMAIL     — your Smartflo/CloudPhone login email
 *   SMARTFLO_PASSWORD  — your Smartflo/CloudPhone login password
 *
 * The dashboard calls this with the logged-in user's Firebase ID token so
 * only your own team can trigger it — Smartflo credentials themselves stay
 * server-side and are never exposed to the browser.
 */

const admin = require('firebase-admin');

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin;
}

// Cache the Smartflo token in memory for the life of this serverless instance
// (tokens are valid for 3600s per Smartflo's docs) so we don't re-login on
// every call within the same warm invocation.
let _smartfloToken = null;
let _smartfloTokenExpiresAt = 0;

async function getSmartfloToken() {
  if (_smartfloToken && Date.now() < _smartfloTokenExpiresAt) return _smartfloToken;

  const email = process.env.SMARTFLO_EMAIL;
  const password = process.env.SMARTFLO_PASSWORD;
  if (!email || !password) throw new Error('SMARTFLO_EMAIL / SMARTFLO_PASSWORD not set in environment variables');

  const res = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Smartflo login failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Smartflo login did not return an access_token');

  _smartfloToken = data.access_token;
  // Refresh a little early (90% of the stated lifetime) to avoid edge-of-expiry failures
  const lifetimeMs = (data.expires_in || 3600) * 1000;
  _smartfloTokenExpiresAt = Date.now() + lifetimeMs * 0.9;
  return _smartfloToken;
}

// Formats a JS Date as Smartflo expects: "Y-m-d H:i:s"
function formatSmartfloDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── Verify the request comes from a logged-in dashboard user ──────────
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Missing Authorization bearer token' });

    const fbAdmin = getAdmin();
    try {
      await fbAdmin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired session — please log in again' });
    }

    // ── Parse request ───────────────────────────────────────────────────
    const {
      fromDate,   // optional, "YYYY-MM-DD" — defaults to today
      toDate,     // optional, "YYYY-MM-DD" — defaults to today
      page = '1',
      limit = '50',
      agentName,  // optional filter, matches agent_name (case-insensitive contains)
      callType,   // 'connected' | 'not_connected' | 'all' — defaults to 'connected'
    } = req.body || {};

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfToday    = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const from = fromDate ? new Date(fromDate + ' 00:00:00') : startOfToday;
    const to   = toDate   ? new Date(toDate   + ' 23:59:59') : endOfToday;

    // ── Fetch from Smartflo ─────────────────────────────────────────────
    const token = await getSmartfloToken();

    const mode = ['connected', 'not_connected', 'all'].includes(callType) ? callType : 'connected';

    const qsParams = {
      from_date: formatSmartfloDate(from),
      to_date:   formatSmartfloDate(to),
      page:      String(page),
      limit:     String(limit),
    };
    // Ask Smartflo to pre-filter where possible; 'all' omits the filter entirely
    if (mode === 'connected') qsParams.call_type = 'c';
    if (mode === 'not_connected') qsParams.call_type = 'm';
    const qs = new URLSearchParams(qsParams);

    const cdrRes = await fetch(`https://api-smartflo.tatateleservices.com/v1/call/records?${qs.toString()}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });

    if (!cdrRes.ok) {
      const errText = await cdrRes.text();
      throw new Error(`Smartflo call records fetch failed (${cdrRes.status}): ${errText}`);
    }

    const cdrData = await cdrRes.json();
    let results = Array.isArray(cdrData.results) ? cdrData.results : [];

    // ★ Only require a real recording for "connected" — not-connected calls
    // never have one, and "all" should show both kinds.
    results = results.filter(r => {
      const isConnected = !!(r.recording_url && Number(r.call_duration) > 0);
      if (mode === 'connected') return isConnected;
      if (mode === 'not_connected') return !isConnected;
      return true; // 'all'
    });

    if (agentName) {
      const needle = agentName.toLowerCase();
      results = results.filter(r => (r.agent_name || '').toLowerCase().includes(needle));
    }

    const calls = results.map(r => ({
      callId:        r.call_id,
      agentName:     r.agent_name || null,
      callerNumber:  r.client_number || r.caller_id_num || null,
      date:          r.date,
      time:          r.time,
      durationSec:   r.call_duration,
      recordingUrl:  r.recording_url || null,
      connected:     !!(r.recording_url && Number(r.call_duration) > 0),
      direction:     r.direction || null,
      department:    r.department_name || null,
    }));

    return res.status(200).json({
      success: true,
      count: calls.length,
      totalAvailable: cdrData.count || calls.length,
      page: cdrData.page || 1,
      calls,
    });

  } catch (error) {
    console.error('Smartflo sync error:', error);
    return res.status(500).json({ error: error.message });
  }
};
