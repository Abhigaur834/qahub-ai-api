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

function normalized(v) { return String(v || '').trim().toLowerCase(); }

async function requireAdmin(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Missing authentication token'), { status: 401 });
  const decoded = await getAuth().verifyIdToken(header.slice(7).trim());
  const db = getDb();
  const email = normalized(decoded.email);
  if (email === 'gaurabhi834@gmail.com') return decoded;
  const snap = await db.ref('admins').once('value');
  const allowed = snap.exists() && Object.values(snap.val()).some(a => normalized(a.email) === email);
  if (!allowed) throw Object.assign(new Error('Admin access required'), { status: 403 });
  return decoded;
}

async function findAgent(db, processId, empId) {
  const snap = await db.ref(`processes/${processId}/agents/${empId}`).once('value');
  if (snap.exists()) return { key: empId, data: snap.val() };
  const all = await db.ref(`processes/${processId}/agents`).once('value');
  if (!all.exists()) return null;
  for (const [key, data] of Object.entries(all.val())) {
    if (normalized(data.empId) === normalized(empId)) return { key, data };
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const decoded = await requireAdmin(req);
    const { processId, empId, email, password } = req.body || {};
    if (!processId || !empId || !email || !password) {
      return res.status(400).json({ error: 'processId, empId, email and password are required' });
    }
    const cleanEmail = normalized(email);
    if (!cleanEmail.includes('@')) return res.status(400).json({ error: 'Valid agent email is required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const db = getDb();
    const agentRef = await findAgent(db, processId, empId);
    if (!agentRef) return res.status(404).json({ error: 'Agent not found in this process' });
    const agent = agentRef.data;
    const auth = getAuth();

    let user;
    let created = false;
    try {
      user = await auth.getUserByEmail(cleanEmail);
      user = await auth.updateUser(user.uid, {
        password: String(password),
        displayName: agent.name || cleanEmail.split('@')[0],
        disabled: false,
      });
    } catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
      user = await auth.createUser({
        email: cleanEmail,
        password: String(password),
        displayName: agent.name || cleanEmail.split('@')[0],
        emailVerified: false,
        disabled: false,
      });
      created = true;
    }

    await auth.setCustomUserClaims(user.uid, {
      role: 'agent',
      processIds: [processId],
      empId: agent.empId || empId,
    });

    await db.ref(`processes/${processId}/agents/${agentRef.key}`).update({
      email: cleanEmail,
      uid: user.uid,
      loginEnabled: true,
      loginUpdatedAt: new Date().toISOString(),
      loginUpdatedBy: decoded.email || null,
    });

    return res.status(created ? 201 : 200).json({
      success: true,
      created,
      updated: !created,
      uid: user.uid,
      email: cleanEmail,
      agentName: agent.name || null,
      processId,
      empId: agent.empId || empId,
    });
  } catch (error) {
    console.error('Create agent login error:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
  }
};

module.exports.config = { maxDuration: 30 };