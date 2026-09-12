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
  const lifetimeMs = (data.expires_in || 3600) * 1000;
  _smartfloTokenExpiresAt = Date.now() + lifetimeMs * 0.9;
  return _smartfloToken;
}

function formatSmartfloDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fetchWithTimeout(url, options, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers['authorization'] || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Missing Authorization bearer token' });

    const fbAdmin = getAdmin();
    try {
      await fbAdmin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired session — please log in again' });
    }

    const {
      fromDate,
      toDate,
      agentName,
      callType,
    } = req.body || {};

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfToday    = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const from = fromDate ? new Date(fromDate + ' 00:00:00') : startOfToday;
    const to   = toDate   ? new Date(toDate   + ' 23:59:59') : endOfToday;

    const token = await getSmartfloToken();
    const mode = ['connected', 'not_connected', 'all'].includes(callType) ? callType : 'connected';

    // Smartflo's call-record endpoint can become very slow with a large
    // page size over a busy day. Keep each request small and time-bound so
    // one slow upstream response cannot consume the whole Vercel function.
    // Raised from the original 4 pages / 100 records — that cap made a
    // sync over any date range wider than a day or two silently stop
    // scanning long before reaching most of the actual call volume, with
    // no indication to the user that anything was cut short. This is
    // still a hard ceiling (Vercel's 60s function limit means we can't
    // scan unlimited records in one request), just a much more usable one.
    const PAGE_SIZE = 50;
    const RETRY_PAGE_SIZE = 10;
    const MAX_PAGES = 10;
    const MAX_MATCHES = 300;
    const BATCH_SIZE = 3;
    const SMARTFLO_TIMEOUT_MS = 12000;

    function buildQs(pageNum, limit) {
      const p = {
        from_date: formatSmartfloDate(from),
        to_date: formatSmartfloDate(to),
        page: String(pageNum),
        limit: String(limit),
      };
      if (mode === 'connected') p.call_type = 'c';
      if (mode === 'not_connected') p.call_type = 'm';
      return new URLSearchParams(p);
    }

    function passesFilter(r) {
      const isConnected = !!(r.recording_url && Number(r.call_duration) > 0);
      const connectedOk = mode === 'connected' ? isConnected : mode === 'not_connected' ? !isConnected : true;
      if (!connectedOk) return false;
      if (agentName) return (r.agent_name || '').toLowerCase().includes(agentName.toLowerCase());
      return true;
    }

    async function fetchPage(pageNum, limit = PAGE_SIZE) {
      const url = `https://api-smartflo.tatateleservices.com/v1/call/records?${buildQs(pageNum, limit).toString()}`;
      try {
        const cdrRes = await fetchWithTimeout(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        }, SMARTFLO_TIMEOUT_MS);
        if (!cdrRes.ok) {
          const errText = await cdrRes.text();
          throw new Error(`Smartflo call records fetch failed (${cdrRes.status}): ${errText}`);
        }
        return await cdrRes.json();
      } catch (error) {
        if (pageNum === 1 && limit === PAGE_SIZE && (error?.name === 'AbortError' || /timed? ?out|timeout/i.test(error?.message || ''))) {
          console.warn('Smartflo first page timed out at 25 rows; retrying with 10 rows');
          const retryUrl = `https://api-smartflo.tatateleservices.com/v1/call/records?${buildQs(1, RETRY_PAGE_SIZE).toString()}`;
          const retryRes = await fetchWithTimeout(retryUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
          }, SMARTFLO_TIMEOUT_MS);
          if (!retryRes.ok) {
            const errText = await retryRes.text();
            throw new Error(`Smartflo call records fetch failed (${retryRes.status}): ${errText}`);
          }
          return retryRes.json();
        }
        if (error?.name === 'AbortError') {
          throw new Error(`Smartflo call records request timed out after ${SMARTFLO_TIMEOUT_MS / 1000}s`);
        }
        throw error;
      }
    }

    let matches = [];
    let totalAvailable = 0;
    let pagesFetched = 0;
    let recordsScanned = 0;

    const firstPage = await fetchPage(1);
    pagesFetched++;
    totalAvailable = firstPage.count || 0;
    const firstResults = Array.isArray(firstPage.results) ? firstPage.results : [];
    recordsScanned += firstResults.length;
    matches.push(...firstResults.filter(passesFilter));

    const totalPagesNeeded = Math.min(MAX_PAGES, Math.ceil(totalAvailable / PAGE_SIZE));
    for (let batchStart = 2; batchStart <= totalPagesNeeded; batchStart += BATCH_SIZE) {
      if (matches.length >= MAX_MATCHES) break;

      const batchPages = [];
      for (let p = batchStart; p < batchStart + BATCH_SIZE && p <= totalPagesNeeded; p++) batchPages.push(p);

      const batchResults = await Promise.all(batchPages.map(p => fetchPage(p)));
      pagesFetched += batchResults.length;

      for (const cdrData of batchResults) {
        const results = Array.isArray(cdrData.results) ? cdrData.results : [];
        recordsScanned += results.length;
        matches.push(...results.filter(passesFilter));
      }
    }

    matches = matches.slice(0, MAX_MATCHES);

    const calls = matches.map(r => ({
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
      totalAvailable,
      recordsScanned,
      pagesFetched,
      truncated: recordsScanned < totalAvailable,
      calls,
    });

  } catch (error) {
    console.error('Smartflo sync error:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports.config = { maxDuration: 60 };
