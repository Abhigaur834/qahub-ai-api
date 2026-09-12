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

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

async function findAgent(db, empId) {
  const processList = await db.ref('processList').once('value');
  const processIds = processList.exists() ? Object.keys(processList.val()) : [];

  for (const processId of processIds) {
    const snap = await db.ref(`processes/${processId}/agents`).once('value');
    if (!snap.exists()) continue;
    for (const [id, agent] of Object.entries(snap.val())) {
      if (norm(agent.empId || id) === norm(empId)) {
        return { processId, id, ...agent };
      }
    }
  }

  // Legacy fallback.
  const legacy = await db.ref('agents').once('value');
  if (legacy.exists()) {
    for (const [id, agent] of Object.entries(legacy.val())) {
      if (norm(agent.empId || id) === norm(empId)) {
        return { processId: String(agent.process || agent.processId || 'LQ').toUpperCase(), id, ...agent };
      }
    }
  }

  return null;
}

async function verifyPassword(email, password) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) fail('FIREBASE_WEB_API_KEY is not configured on the API', 500);

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(data?.error?.message || 'AUTH_FAILED');
    if (code.includes('EMAIL_NOT_FOUND') || code.includes('INVALID_PASSWORD')) fail('Invalid Employee ID or password', 401);
    if (code.includes('USER_DISABLED')) fail('Your agent account is disabled. Contact QA/TL.', 403);
    fail('Unable to sign in right now', 401);
  }
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const empId = String(req.body?.empId || '').trim();
    const password = String(req.body?.password || '');
    if (!empId || !password) fail('Employee ID and password are required');
    if (empId.length > 80 || password.length > 200) fail('Invalid credentials');

    const db = getDb();
    const agent = await findAgent(db, empId);
    if (!agent) fail('Invalid Employee ID or password', 401);
    if (!agent.email) fail('This agent profile has no login email configured. Contact QA/TL.', 403);

    const authResult = await verifyPassword(agent.email, password);
    const auth = getAuth();
    const user = await auth.getUser(authResult.localId);

    if (user.disabled) fail('Your agent account is disabled. Contact QA/TL.', 403);

    const customToken = await auth.createCustomToken(user.uid, {
      role: 'agent',
      empId: String(agent.empId || empId),
      processId: String(agent.processId || agent.process || agent.processId || ''),
    });

    return res.status(200).json({
      success: true,
      token: customToken,
      processId: agent.processId || agent.process || agent.processId || null,
      agentName: agent.name || null,
    });
  } catch (error) {
    console.error('Agent ID login error:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Login failed' });
  }
};

module.exports.config = { maxDuration: 20 };