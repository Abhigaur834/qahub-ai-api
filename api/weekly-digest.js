/**
 * QA.Hub — Weekly Performance Digest
 *
 * Runs on a schedule (Vercel Cron — see vercel.json), not triggered by any
 * button. For every process, summarizes the last 7 days of audits and
 * emails it to that process's Team Leaders (their emails, collected from
 * the agent directory) plus your super admins.
 *
 * Uses Resend (https://resend.com) — set RESEND_API_KEY. Skips silently if
 * that isn't set yet.
 */

const admin = require('firebase-admin');

function getDb() {
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
  return admin.database();
}

function snapToArray(snap) {
  if (!snap.exists()) return [];
  return Object.entries(snap.val() || {}).map(([key, val]) => ({ key, ...val }));
}

async function getSuperAdminEmails(db) {
  const snap = await db.ref('admins').once('value');
  const emails = snapToArray(snap).map(a => a.email).filter(Boolean);
  return [...new Set(emails)];
}

async function buildDigestForProcess(db, processId) {
  const sevenDaysAgo = Date.now() - 7 * 86400000;

  const auditsSnap = await db.ref(`processes/${processId}/audits`).once('value');
  const allAudits = snapToArray(auditsSnap);
  const weekAudits = allAudits.filter(a => a.timestamp && a.timestamp > sevenDaysAgo);

  const agentsSnap = await db.ref(`processes/${processId}/agents`).once('value');
  const agents = snapToArray(agentsSnap);
  const tlEmails = [...new Set(agents.map(a => a.tlEmail).filter(Boolean))];

  const v = weekAudits.filter(a => a.totalScore != null);
  const avgScore = v.length ? Math.round(v.reduce((s, a) => s + a.totalScore, 0) / v.length) : null;
  const passRate = v.length ? Math.round(v.filter(a => a.result === 'Pass').length / v.length * 100) : null;
  const fatalCount = weekAudits.filter(a => a.crFatal).length;

  // At-risk agents this week — same pattern as the internal Dip Alerts
  const agentMap = {};
  allAudits.forEach(a => {
    if (!a.agent) return;
    (agentMap[a.agent] = agentMap[a.agent] || []).push(a);
  });
  const riskAgents = [];
  Object.entries(agentMap).forEach(([name, aa]) => {
    const sorted = [...aa].filter(a => a.totalScore != null).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (sorted.length >= 3 && sorted.slice(0, 3).every(a => a.totalScore < 70)) riskAgents.push(name);
  });

  return {
    processId, weekAuditCount: weekAudits.length, avgScore, passRate, fatalCount,
    riskAgents: [...new Set(riskAgents)], tlEmails,
  };
}

function buildEmailHtml(digest) {
  const scoreColor = digest.avgScore == null ? '#999' : digest.avgScore >= 85 ? '#22d38a' : digest.avgScore >= 70 ? '#f08040' : '#f04060';
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <h2 style="margin-bottom:4px">Weekly QA Digest — ${digest.processId}</h2>
      <p style="color:#666;font-size:13px;margin-top:0">Last 7 days</p>
      <div style="display:flex;gap:12px;margin:16px 0">
        <div style="flex:1;background:#f7f7f9;border-radius:10px;padding:14px">
          <div style="font-size:11px;color:#666;text-transform:uppercase">Audits</div>
          <div style="font-size:24px;font-weight:800">${digest.weekAuditCount}</div>
        </div>
        <div style="flex:1;background:#f7f7f9;border-radius:10px;padding:14px">
          <div style="font-size:11px;color:#666;text-transform:uppercase">Avg Score</div>
          <div style="font-size:24px;font-weight:800;color:${scoreColor}">${digest.avgScore != null ? digest.avgScore + '%' : '—'}</div>
        </div>
        <div style="flex:1;background:#f7f7f9;border-radius:10px;padding:14px">
          <div style="font-size:11px;color:#666;text-transform:uppercase">Pass Rate</div>
          <div style="font-size:24px;font-weight:800">${digest.passRate != null ? digest.passRate + '%' : '—'}</div>
        </div>
      </div>
      ${digest.fatalCount > 0 ? `<p style="color:#f04060;font-weight:700;font-size:13px">⚡ ${digest.fatalCount} FATAL failure(s) this week</p>` : ''}
      ${digest.riskAgents.length ? `<h3 style="font-size:14px;margin-top:16px">🚨 Agents needing attention</h3><ul style="font-size:13px;color:#444">${digest.riskAgents.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : '<p style="color:#22d38a;font-size:13px;margin-top:16px">✅ No agents currently flagged.</p>'}
      <p style="color:#999;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Automated weekly summary from QA.Hub.</p>
    </div>`;
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const queryOk = req.query && req.query.secret === process.env.CRON_SECRET;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && !queryOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(200).json({ success: true, skipped: 'RESEND_API_KEY not configured' });
  }

  try {
    const db = getDb();
    const superAdmins = await getSuperAdminEmails(db);
    const processListSnap = await db.ref('processList').once('value');
    const processIds = Object.keys(processListSnap.val() || {});

    const results = {};
    for (const pid of processIds) {
      try {
        const digest = await buildDigestForProcess(db, pid);
        const recipients = [...new Set([...digest.tlEmails, ...superAdmins])];
        if (!recipients.length) { results[pid] = 'skipped: no recipients on file'; continue; }
        if (!digest.weekAuditCount) { results[pid] = 'skipped: no audits this week'; continue; }

        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: process.env.RESEND_FROM_EMAIL || 'QA.Hub <onboarding@resend.dev>',
            to: recipients,
            subject: `Weekly QA Digest — ${pid} (${digest.weekAuditCount} audits)`,
            html: buildEmailHtml(digest),
          }),
        });
        if (!resendRes.ok) throw new Error(`Resend ${resendRes.status}: ${await resendRes.text()}`);
        results[pid] = `sent to ${recipients.length} recipient(s)`;
      } catch (e) {
        console.error(`Digest failed for ${pid}:`, e);
        results[pid] = 'error: ' + e.message;
      }
    }

    return res.status(200).json({ success: true, processedAt: new Date().toISOString(), results });
  } catch (error) {
    console.error('weekly-digest error:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports.config = { maxDuration: 60 };
