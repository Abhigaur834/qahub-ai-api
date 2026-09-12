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

async function requireUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Missing authentication token'), { status: 401 });
  return admin.auth().verifyIdToken(header.slice(7).trim());
}

function norm(v) { return String(v || '').trim().toLowerCase(); }
function ownsCall(call, agent) {
  if (call.agentEmail && norm(call.agentEmail) === norm(agent.email)) return true;
  if (call.agentEmpId && agent.empId && norm(call.agentEmpId) === norm(agent.empId)) return true;
  return norm(call.agentName) === norm(agent.name);
}

async function findAgent(db, processId, email) {
  const snap = await db.ref(`processes/${processId}/agents`).once('value');
  if (!snap.exists()) return null;
  for (const data of Object.values(snap.val())) {
    if (norm(data.email) === norm(email)) return data;
  }
  return null;
}

async function smartfloToken() {
  const email = process.env.SMARTFLO_EMAIL;
  const password = process.env.SMARTFLO_PASSWORD;
  if (!email || !password) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api-smartflo.tatateleservices.com/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Smartflo authentication failed (${res.status})`);
    const data = await res.json();
    return data.access_token || null;
  } finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await requireUser(req);
    const processId = String(req.query.processId || '').trim();
    const callKey = String(req.query.callKey || '').trim();
    if (!processId || !callKey) return res.status(400).json({ error: 'processId and callKey required' });

    const db = getDb();
    const agent = await findAgent(db, processId, decoded.email);
    if (!agent) return res.status(403).json({ error: 'Agent is not assigned to this process' });

    const callSnap = await db.ref(`processes/${processId}/calls/${callKey}`).once('value');
    if (!callSnap.exists()) return res.status(404).json({ error: 'Call not found' });
    const call = callSnap.val();
    if (!ownsCall(call, agent)) return res.status(403).json({ error: 'You can only play your own calls' });
    if (!call.recordingUrl) return res.status(404).json({ error: 'Recording not available' });

    const token = await smartfloToken();
    const headers = { Accept: 'audio/*,application/octet-stream,*/*', 'User-Agent': 'QA.Hub-Agent/1.0' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (req.headers.range) headers.Range = req.headers.range;

    const audioRes = await fetch(call.recordingUrl, { headers, redirect: 'follow' });
    if (!audioRes.ok) return res.status(audioRes.status).json({ error: `Recording provider returned ${audioRes.status}` });

    const contentType = (audioRes.headers.get('content-type') || 'audio/mpeg').split(';')[0];
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    res.status(audioRes.status === 206 ? 206 : 200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', audioRes.headers.get('accept-ranges') || 'bytes');
    const contentLength = audioRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    const contentRange = audioRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.send(buffer);
  } catch (error) {
    console.error('Agent recording error:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
  }
};

module.exports.config = { maxDuration: 60 };
