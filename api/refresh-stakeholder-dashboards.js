/**
 * QA.Hub — Stakeholder Dashboard Auto-Refresh
 *
 * Runs on a schedule (Vercel Cron — see vercel.json), NOT triggered by any
 * button in the dashboard. For every process, it recomputes an aggregated,
 * PII-safe performance snapshot and writes it to publicDashboards/{processId}
 * in Firebase — the same path the public stakeholder.html page reads from.
 *
 * Nothing raw (recordings, customer numbers, audit notes, coaching text)
 * ever leaves this function — only computed numbers.
 *
 * Security: only Vercel's own Cron scheduler can call this. Vercel
 * automatically sends `Authorization: Bearer <CRON_SECRET>` on scheduled
 * invocations when a CRON_SECRET env var is set — this function rejects
 * anything else.
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

// ── Legacy 22-parameter fallback — mirrors ai-score.js exactly ────────────
const LEGACY_NC_POINTS = { nc1:10,nc2:10,nc3:5,nc4:10,nc5:10,nc6:10,nc7:10,nc8:10,nc9:5,nc10:5,nc11:10,nc12:5 };
const LEGACY_NCK = Object.keys(LEGACY_NC_POINTS);
const LEGACY_CRK = ['cr1','cr2','cr3','cr4','cr5','cr6','cr7','cr8','cr9','cr10'];
const LEGACY_NC_LABELS = {
  nc1:'Standard opening & customer name confirmation', nc2:'Summarization', nc3:'Further assistance offered',
  nc4:'Prescribed call closing', nc5:'Paraphrasing for alignment', nc6:'Customer VOC acknowledged',
  nc7:'Relevant probing questions asked', nc8:'Active Listening / Reading', nc9:'Hold & Dead Air SLA',
  nc10:'Apologies, Empathy & Politeness', nc11:'No Overlapping / Interruptions', nc12:'Accurate Email to Client',
};
const LEGACY_CR_LABELS = {
  cr1:'Professional & polite throughout', cr2:'Called within timeframe & TZ', cr3:'Complete & accurate information',
  cr4:'Timely queries + right disposition', cr5:'Qualifying questions + notes updated', cr6:'Opportunity created post-call',
  cr7:'Special requirements noted', cr8:'Non-sales queries redirected', cr9:'All client questions answered',
  cr10:'Lead converted without pushing',
};

async function getProcessPM(db, processId) {
  try {
    const snap = await db.ref(`processList/${processId}/parameters`).once('value');
    const custom = snap.exists() ? snap.val() : null;
    if (custom && Object.keys(custom).length) {
      const PM = {};
      Object.keys(custom).forEach(id => {
        const p = custom[id];
        PM[id] = { label: p.label, type: p.critical ? 'CR' : 'NC' };
      });
      return PM;
    }
  } catch (e) { /* fall through to legacy */ }
  const PM = {};
  LEGACY_NCK.forEach(k => PM[k] = { label: LEGACY_NC_LABELS[k], type: 'NC' });
  LEGACY_CRK.forEach(k => PM[k] = { label: LEGACY_CR_LABELS[k], type: 'CR' });
  return PM;
}

function getISOWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return { week: Math.ceil((((dt - yearStart) / 86400000) + 1) / 7), year: dt.getUTCFullYear() };
}

// Safe snapshot-to-array helper — NEVER use snap.forEach directly with an
// implicit-return arrow function. Firebase's forEach cancels iteration early
// if the callback returns anything truthy (e.g. Array.push()'s return value),
// which silently truncated the dashboard's own call queue to 1 item earlier
// in this project. Object.values() sidesteps that entirely.
function snapToArray(snap) {
  if (!snap.exists()) return [];
  return Object.entries(snap.val() || {}).map(([key, val]) => ({ key, ...val }));
}

async function buildSnapshotForProcess(db, processId) {
  const auditsSnap = await db.ref(`processes/${processId}/audits`).once('value');
  const audits = snapToArray(auditsSnap);

  const coachSnap = await db.ref(`processes/${processId}/coaching`).once('value');
  const coaching = snapToArray(coachSnap);

  const PM = await getProcessPM(db, processId);

  const v = audits.filter(a => a.totalScore !== null && a.totalScore !== undefined);
  const avgScore = v.length ? Math.round(v.reduce((s, a) => s + a.totalScore, 0) / v.length) : null;
  const passRate = v.length ? Math.round(v.filter(a => a.result === 'Pass').length / v.length * 100) : null;
  const fatalCount = audits.filter(a => a.crFatal).length;
  const fatalRate = audits.length ? Math.round(fatalCount / audits.length * 100) : 0;

  // Monthly trend (last 12 months)
  const mmap = {};
  audits.forEach(a => {
    const ds = a.date || a.callDate;
    if (!ds || a.totalScore == null) return;
    const k = ds.slice(0, 7);
    (mmap[k] = mmap[k] || []).push(a.totalScore);
  });
  const monthKeys = Object.keys(mmap).sort().slice(-12);
  const monthlyTrend = monthKeys.map(k => {
    const [y, m] = k.split('-');
    return { label: new Date(+y, +m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), avgScore: Math.round(mmap[k].reduce((s, x) => s + x, 0) / mmap[k].length) };
  });

  // Weekly trend (last 12 weeks)
  const wmap = {};
  audits.forEach(a => {
    const ds = a.callDate || a.date;
    if (!ds || a.totalScore == null) return;
    const d = new Date(ds);
    if (isNaN(d)) return;
    const { week, year } = getISOWeek(d);
    const k = `${year}-W${String(week).padStart(2, '0')}`;
    (wmap[k] = wmap[k] || []).push(a.totalScore);
  });
  const weekKeys = Object.keys(wmap).sort().slice(-12);
  const weeklyTrend = weekKeys.map(k => ({ label: k, avgScore: Math.round(wmap[k].reduce((s, x) => s + x, 0) / wmap[k].length) }));

  // Volume by month
  const volMap = {};
  audits.forEach(a => {
    const ds = a.date || a.callDate;
    if (!ds) return;
    const k = ds.slice(0, 7);
    volMap[k] = volMap[k] || { pass: 0, review: 0, fail: 0 };
    if (a.result === 'Pass') volMap[k].pass++;
    else if (a.result === 'Review') volMap[k].review++;
    else if (a.result) volMap[k].fail++;
  });
  const volumeByMonth = Object.keys(volMap).sort().slice(-6).map(k => {
    const [y, m] = k.split('-');
    return { label: new Date(+y, +m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), ...volMap[k] };
  });

  // Pareto — top failing parameters, using this process's own parameter set
  const failMap = {}, totalRated = {};
  Object.keys(PM).forEach(k => { failMap[k] = 0; totalRated[k] = 0; });
  audits.forEach(a => {
    if (!a.scores) return;
    Object.keys(PM).forEach(k => {
      if (!(k in a.scores)) return;
      if (a.scores[k] === 'yes' || a.scores[k] === 'no') totalRated[k]++;
      if (a.scores[k] === 'no') failMap[k]++;
    });
  });
  const paretoTop = Object.keys(PM)
    .map(k => ({ label: PM[k].label, type: PM[k].type, fails: failMap[k], total: totalRated[k], failRate: totalRated[k] ? Math.round(failMap[k] / totalRated[k] * 100) : 0 }))
    .sort((a, b) => b.fails - a.fails).slice(0, 8);
  const ncFails = Object.keys(PM).filter(k => PM[k].type === 'NC').reduce((s, k) => s + failMap[k], 0);
  const crFails = Object.keys(PM).filter(k => PM[k].type === 'CR').reduce((s, k) => s + failMap[k], 0);

  // Leaderboard
  const agentMap = {};
  audits.forEach(a => {
    if (!a.agent) return;
    agentMap[a.agent] = agentMap[a.agent] || { name: a.agent, team: a.team || '—', evals: [] };
    agentMap[a.agent].evals.push(a);
  });
  const leaderboard = Object.values(agentMap).map(ag => {
    const av = ag.evals.filter(e => e.totalScore != null);
    return {
      name: ag.name, team: ag.team, evals: ag.evals.length,
      avgScore: av.length ? Math.round(av.reduce((s, e) => s + e.totalScore, 0) / av.length) : null,
      passRate: av.length ? Math.round(av.filter(e => e.result === 'Pass').length / av.length * 100) : null,
      fatalCount: ag.evals.filter(e => e.crFatal).length,
    };
  }).filter(ag => ag.avgScore !== null).sort((a, b) => b.avgScore - a.avgScore).slice(0, 50);

  // Team comparison
  const teamMap = {};
  audits.forEach(a => {
    const t = a.team || 'Unknown';
    teamMap[t] = teamMap[t] || { evals: [], agents: new Set() };
    teamMap[t].evals.push(a);
    teamMap[t].agents.add(a.agent);
  });
  const teamComparison = Object.entries(teamMap).map(([name, t]) => {
    const tv = t.evals.filter(e => e.totalScore != null);
    return {
      name, agents: t.agents.size, evals: t.evals.length,
      avgScore: tv.length ? Math.round(tv.reduce((s, e) => s + e.totalScore, 0) / tv.length) : null,
      passRate: tv.length ? Math.round(tv.filter(e => e.result === 'Pass').length / tv.length * 100) : null,
    };
  });

  // Score distribution — how spread out are audit scores, not just the average
  const distBuckets = new Array(10).fill(0);
  v.forEach(a => { const b = Math.min(Math.floor(a.totalScore / 10), 9); distBuckets[b]++; });
  const scoreDistribution = distBuckets.map((count, i) => ({ label: `${i * 10}-${i * 10 + 9}%`, count }));

  // Fatal failures by month — separate trend line, not just a single total
  const fatalMonMap = {};
  audits.forEach(a => {
    const ds = a.date || a.callDate;
    if (!ds) return;
    const k = ds.slice(0, 7);
    fatalMonMap[k] = fatalMonMap[k] || 0;
    if (a.crFatal) fatalMonMap[k]++;
  });
  const fatalTrend = Object.keys(fatalMonMap).sort().slice(-6).map(k => {
    const [y, m] = k.split('-');
    return { label: new Date(+y, +m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), count: fatalMonMap[k] };
  });

  // Period-over-period deltas — last 30 days vs the 30 days before that
  const now = Date.now();
  const last30 = audits.filter(a => a.totalScore != null && a.timestamp && (now - a.timestamp) <= 30 * 86400000);
  const prev30 = audits.filter(a => a.totalScore != null && a.timestamp && (now - a.timestamp) > 30 * 86400000 && (now - a.timestamp) <= 60 * 86400000);
  const last30Avg = last30.length ? Math.round(last30.reduce((s, a) => s + a.totalScore, 0) / last30.length) : null;
  const prev30Avg = prev30.length ? Math.round(prev30.reduce((s, a) => s + a.totalScore, 0) / prev30.length) : null;
  const last30PassRate = last30.length ? Math.round(last30.filter(a => a.result === 'Pass').length / last30.length * 100) : null;
  const prev30PassRate = prev30.length ? Math.round(prev30.filter(a => a.result === 'Pass').length / prev30.length * 100) : null;

  // At-risk agents — same early-warning logic as the internal dashboard's Dip Alerts,
  // surfaced here so stakeholders can see quality issues are being proactively caught
  const riskAlerts = [];
  Object.entries(agentMap).forEach(([agentName, ag]) => {
    const sorted = [...ag.evals].filter(a => a.totalScore != null).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (sorted.length >= 3 && sorted.slice(0, 3).every(a => a.totalScore < 70)) {
      riskAlerts.push({ agent: agentName, reason: '3 consecutive scores below 70%' });
    }
    const sevenDaysAgo = now - 7 * 86400000;
    const recentFatal = ag.evals.filter(a => a.crFatal && a.timestamp && a.timestamp > sevenDaysAgo);
    if (recentFatal.length >= 2) {
      riskAlerts.push({ agent: agentName, reason: '2+ fatal failures in the last 7 days' });
    }
  });

  // Coaching impact — per-agent before/after averages only, never session notes
  const coachingDetail = [];
  let improvementSum = 0, improvementCount = 0;
  for (const s of coaching) {
    const d = new Date(s.date || s.timestamp);
    const before = audits.filter(a => a.agent === s.agent && new Date(a.date || a.callDate) < d && new Date(a.date || a.callDate) > new Date(d.getTime() - 30 * 86400000) && a.totalScore != null);
    const after = audits.filter(a => a.agent === s.agent && new Date(a.date || a.callDate) >= d && new Date(a.date || a.callDate) < new Date(d.getTime() + 30 * 86400000) && a.totalScore != null);
    if (before.length && after.length) {
      const bAvg = Math.round(before.reduce((s, a) => s + a.totalScore, 0) / before.length);
      const aAvg = Math.round(after.reduce((s, a) => s + a.totalScore, 0) / after.length);
      improvementSum += (aAvg - bAvg);
      improvementCount++;
      coachingDetail.push({ agent: s.agent, beforeAvg: bAvg, afterAvg: aAvg, delta: aAvg - bAvg });
    }
  }

  return {
    processId,
    generatedAt: new Date().toISOString(),
    generatedBy: 'auto-scheduled',
    kpis: {
      avgScore, passRate, totalAudits: audits.length, fatalCount, fatalRate,
      scoreDelta: (last30Avg != null && prev30Avg != null) ? last30Avg - prev30Avg : null,
      passRateDelta: (last30PassRate != null && prev30PassRate != null) ? last30PassRate - prev30PassRate : null,
    },
    monthlyTrend, weeklyTrend, volumeByMonth, fatalTrend, scoreDistribution,
    paretoTop, ncCrSplit: { nc: ncFails, cr: crFails },
    leaderboard, teamComparison, riskAlerts: riskAlerts.slice(0, 20),
    coaching: {
      sessionsLogged: coaching.length,
      avgImprovement: improvementCount ? Math.round((improvementSum / improvementCount) * 10) / 10 : null,
      detail: coachingDetail.slice(0, 20),
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vercel's own Cron scheduler sends `Authorization: Bearer <CRON_SECRET>`.
  // For manual/browser testing, a `?secret=` query param is also accepted —
  // just visit the URL directly with your secret appended.
  const authHeader = req.headers['authorization'] || '';
  const bearerOk = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const queryOk = req.query && req.query.secret === process.env.CRON_SECRET;
  if (!bearerOk && !queryOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = getDb();
    const processListSnap = await db.ref('processList').once('value');
    const processIds = Object.keys(processListSnap.val() || {});

    const results = {};
    for (const pid of processIds) {
      try {
        const snapshot = await buildSnapshotForProcess(db, pid);
        await db.ref(`publicDashboards/${pid}`).set(snapshot);
        results[pid] = 'ok';
      } catch (e) {
        console.error(`Snapshot failed for ${pid}:`, e);
        results[pid] = 'error: ' + e.message;
      }
    }

    return res.status(200).json({ success: true, processedAt: new Date().toISOString(), results });
  } catch (error) {
    console.error('refresh-stakeholder-dashboards error:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports.config = { maxDuration: 60 };
