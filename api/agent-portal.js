const admin = require('firebase-admin');

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  return admin.database();
}

function getAuth() {
  if (!admin.apps.length) getDb();
  return admin.auth();
}

async function requireUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Missing authentication token'), { status: 401 });
  const token = header.slice(7).trim();
  if (!token) throw Object.assign(new Error('Missing authentication token'), { status: 401 });
  return getAuth().verifyIdToken(token);
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function matchesAgent(record, agent) {
  if (!record) return false;
  if (record.email && norm(record.email) === norm(agent.email)) return true;
  if (record.empId && agent.empId && norm(record.empId) === norm(agent.empId)) return true;
  if (record.uid && agent.uid && record.uid === agent.uid) return true;
  if (record.name && agent.name && norm(record.name) === norm(agent.name)) return true;
  return false;
}

async function findAgentForUser(db, email) {
  const processesSnap = await db.ref('processList').once('value');
  const processIds = processesSnap.exists() ? Object.keys(processesSnap.val()) : [];
  const found = [];

  for (const processId of processIds) {
    const snap = await db.ref(`processes/${processId}/agents`).once('value');
    if (!snap.exists()) continue;
    Object.entries(snap.val()).forEach(([id, data]) => {
      if (norm(data.email) === norm(email)) found.push({ processId, id, ...data });
    });
  }

  // Legacy fallback for agents stored before the process migration.
  if (!found.length) {
    const snap = await db.ref('agents').once('value');
    if (snap.exists()) {
      Object.entries(snap.val()).forEach(([id, data]) => {
        if (norm(data.email) === norm(email)) found.push({ processId: String(data.process || data.processId || 'LQ').toUpperCase(), id, ...data });
      });
    }
  }

  return found;
}

async function loadProcessAudits(db, processId, agent) {
  const snap = await db.ref(`processes/${processId}/audits`).once('value');
  if (!snap.exists()) return [];
  return Object.entries(snap.val())
    .map(([id, d]) => ({ id, processId, ...d }))
    .filter(a => {
      if (a.agentEmail && norm(a.agentEmail) === norm(agent.email)) return true;
      return matchesAgent({ name: a.agent, empId: a.empId }, agent);
    });
}

async function loadProcessCalls(db, processId, agent) {
  const snap = await db.ref(`processes/${processId}/calls`).once('value');
  if (!snap.exists()) return [];
  return Object.entries(snap.val())
    .map(([id, d]) => ({ id, callKey: id, processId, ...d }))
    .filter(c => {
      if (c.agentEmail && norm(c.agentEmail) === norm(agent.email)) return true;
      if (c.agentEmpId && agent.empId && norm(c.agentEmpId) === norm(agent.empId)) return true;
      return norm(c.agentName) === norm(agent.name);
    });
}

function scoreFromAudit(a) {
  return Number.isFinite(Number(a.totalScore)) ? Number(a.totalScore) : null;
}

function buildPerformance(audits) {
  const scored = audits.map(scoreFromAudit).filter(v => v !== null);
  const avg = scored.length ? Math.round(scored.reduce((s, v) => s + v, 0) / scored.length * 10) / 10 : null;
  const passed = audits.filter(a => String(a.result || '').toLowerCase() === 'pass').length;
  const fatal = audits.filter(a => a.crFatal).length;
  const pending = audits.filter(a => !a.agentAcknowledgement || a.agentAcknowledgement.status !== 'acknowledged').length;
  const parameterStats = {};

  audits.forEach(a => {
    const scores = a.scores || {};
    Object.entries(scores).forEach(([key, value]) => {
      if (!parameterStats[key]) parameterStats[key] = { rated: 0, pass: 0, fail: 0 };
      if (value === 'yes' || value === 'no') {
        parameterStats[key].rated += 1;
        if (value === 'yes') parameterStats[key].pass += 1;
        if (value === 'no') parameterStats[key].fail += 1;
      }
    });
  });

  return {
    audits: audits.length,
    averageScore: avg,
    passRate: audits.length ? Math.round(passed / audits.length * 1000) / 10 : null,
    criticalFailures: fatal,
    pendingAcknowledgement: pending,
    acknowledgementRate: audits.length ? Math.round((audits.length - pending) / audits.length * 1000) / 10 : null,
    parameterStats,
  };
}

function safeAudit(a, callMap) {
  const callId = a.callId || a.callKey;
  const linked = callMap.get(String(callId || '')) || null;
  return {
    id: a.id,
    processId: a.processId,
    callId: a.callId || null,
    callKey: a.callKey || linked?.callKey || null,
    callDate: a.callDate || null,
    date: a.date || null,
    score: scoreFromAudit(a),
    result: a.result || null,
    auditType: a.auditType || 'Manual',
    reviewer: a.reviewer || a.createdBy || null,
    empId: a.empId || null,
    tlName: a.tlName || null,
    team: a.team || null,
    tenure: a.tenure || null,
    channel: a.channel || null,
    crFatal: Boolean(a.crFatal),
    crFailCount: Number(a.crFailCount || 0),
    ncScore: a.ncScore ?? null,
    ncEarned: a.ncEarned ?? null,
    ncTotal: a.ncTotal ?? null,
    scores: a.scores || {},
    summary: a.summary || '',
    observations: a.observations || '',
    recommendation: a.recommendation || '',
    agentAcknowledgement: a.agentAcknowledgement || { status: 'pending' },
    recordingUrl: a.recordingUrl || linked?.recordingUrl || null,
    callDuration: linked?.transcript?.stats?.durationSeconds || linked?.durationSeconds || null,
    transcriptAvailable: Boolean(linked?.transcript?.full),
  };
}

async function getPortalData(req) {
  const decoded = await requireUser(req);
  const db = getDb();
  const agents = await findAgentForUser(db, decoded.email);
  if (!agents.length) throw Object.assign(new Error('No agent profile is linked to this account'), { status: 403 });

  const allAudits = [];
  const allCalls = [];
  const profiles = [];
  const callMap = new Map();

  for (const agent of agents) {
    const [audits, calls] = await Promise.all([
      loadProcessAudits(db, agent.processId, agent),
      loadProcessCalls(db, agent.processId, agent),
    ]);
    profiles.push({
      processId: agent.processId,
      name: agent.name || decoded.name || decoded.email.split('@')[0],
      empId: agent.empId || null,
      email: agent.email || decoded.email,
      tl: agent.tl || null,
      team: agent.team || null,
      tenure: agent.tenure || null,
    });
    calls.forEach(c => callMap.set(String(c.id), c));
    calls.forEach(c => { if (c.callId) callMap.set(String(c.callId), c); });
    allCalls.push(...calls);
    allAudits.push(...audits);
  }

  const audits = allAudits
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .map(a => safeAudit(a, callMap));

  // Only expose calls that are already auditable/processed in the agent portal.
  const auditedCallIds = new Set(audits.flatMap(a => [a.callKey, a.callId].filter(Boolean).map(String)));
  const calls = allCalls
    .filter(c => auditedCallIds.has(String(c.id)) || auditedCallIds.has(String(c.callId || '')))
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .map(c => ({
      callKey: c.callKey || c.id,
      processId: c.processId,
      callId: c.callId || null,
      agentName: c.agentName || null,
      callerNumber: c.callerNumber ? String(c.callerNumber).replace(/(\\d{2})\\d+(\\d{2})$/, '$1****$2') : null,
      recordingReady: Boolean(c.recordingUrl),
      durationSeconds: c.transcript?.stats?.durationSeconds || c.durationSeconds || null,
      status: c.status || null,
      createdAt: c.createdAt || null,
    }));

  const primary = profiles[0];
  return {
    profile: primary,
    profiles,
    performance: buildPerformance(allAudits),
    audits,
    calls,
    generatedAt: new Date().toISOString(),
  };
}

async function handleAction(req) {
  const decoded = await requireUser(req);
  const db = getDb();
  const { action, processId, auditId, reason } = req.body || {};
  if (!['acknowledge', 'request_review'].includes(action)) throw Object.assign(new Error('Unsupported action'), { status: 400 });
  if (!processId || !auditId) throw Object.assign(new Error('processId and auditId are required'), { status: 400 });

  const [auditSnap, agentSnap] = await Promise.all([
    db.ref(`processes/${processId}/audits/${auditId}`).once('value'),
    db.ref(`processes/${processId}/agents`).once('value'),
  ]);
  if (!auditSnap.exists()) throw Object.assign(new Error('Audit not found'), { status: 404 });

  const agents = [];
  if (agentSnap.exists()) Object.values(agentSnap.val()).forEach(a => agents.push(a));
  const agent = agents.find(a => norm(a.email) === norm(decoded.email));
  if (!agent) throw Object.assign(new Error('Agent is not assigned to this process'), { status: 403 });

  const audit = auditSnap.val();
  if (!matchesAgent({ name: audit.agent, empId: audit.empId, email: audit.agentEmail }, agent)) {
    throw Object.assign(new Error('You can only act on your own audits'), { status: 403 });
  }

  const now = new Date().toISOString();
  const acknowledgement = action === 'acknowledge'
    ? { status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: decoded.email }
    : { status: 'review_requested', requestedAt: now, requestedBy: decoded.email, reason: String(reason || '').trim().slice(0, 1000) };

  await Promise.all([
    db.ref(`processes/${processId}/audits/${auditId}/agentAcknowledgement`).set(acknowledgement),
    db.ref(`processes/${processId}/agentActions/${auditId}/${decoded.uid}`).set({ action, ...acknowledgement }),
  ]);

  return { success: true, action, acknowledgement };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') return res.status(200).json(await getPortalData(req));
    if (req.method === 'POST') return res.status(200).json(await handleAction(req));
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Agent portal API error:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
  }
};

module.exports.config = { maxDuration: 60 };
