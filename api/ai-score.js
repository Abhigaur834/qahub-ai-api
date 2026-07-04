/**
 * QA.Hub — AI Scoring via Google Gemini Flash (FREE)
 * Free tier: 15 RPM, 1 million tokens/day — no credit card needed.
 * Get your free key at: https://aistudio.google.com/app/apikey
 *
 * Scores a transcript against the CALLING PROCESS'S OWN locked parameter set
 * (processList/{processId}/parameters in Firebase — the same set the
 * dashboard's "Define Audit Parameters" builder writes when a process is
 * created). If a process has no stored parameters (e.g. it predates the
 * per-process builder), this falls back to the original 22-parameter sales
 * scorecard so nothing about your existing sales process changes.
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

// ── LEGACY (default) 22-parameter scorecard — used whenever a process has no
//    parameters stored under processList/{processId}/parameters. This is the
//    exact set your sales process has always scored against; nothing about
//    it changes. ─────────────────────────────────────────────────────────
const LEGACY_NC_POINTS = {
  nc1: 10, nc2: 10, nc3: 5,  nc4: 10,
  nc5: 10, nc6: 10, nc7: 10,
  nc8: 10, nc9: 5,  nc10: 5, nc11: 10, nc12: 5,
};
const LEGACY_NCK = Object.keys(LEGACY_NC_POINTS);
const LEGACY_CRK = ['cr1','cr2','cr3','cr4','cr5','cr6','cr7','cr8','cr9','cr10'];

const LEGACY_NC_LABELS = {
  nc1:  '(10pts) Standard opening & customer name confirmation',
  nc2:  '(10pts) Summarization — agent summarised the issue',
  nc3:  '(5pts)  Further assistance offered before closing',
  nc4:  '(10pts) Prescribed call closing used',
  nc5:  '(10pts) Paraphrasing — repeated back to confirm understanding',
  nc6:  '(10pts) Customer VOC understood and acknowledged',
  nc7:  '(10pts) Relevant probing questions asked',
  nc8:  '(10pts) Active Listening / Reading demonstrated',
  nc9:  '(5pts)  Hold and Dead Air SLA followed (<30s hold with permission)',
  nc10: '(5pts)  Apologies, Empathy, and Politeness demonstrated',
  nc11: '(10pts) Conversation without overlapping or interruptions',
  nc12: '(5pts)  Accurate email sent to client (if applicable)',
};
const LEGACY_CR_LABELS = {
  cr1:  'Agent remained professional, polite, and pleasant throughout',
  cr2:  'Called client within timeframe & accommodated callback per global timezone',
  cr3:  'Provided complete and accurate information',
  cr4:  'Answered queries timely and effectively; chose right disposition',
  cr5:  'Asked qualifying questions and updated notes per standard procedure',
  cr6:  'Successfully created an opportunity after the conversation',
  cr7:  'Updated special requirements in notes for other teams',
  cr8:  'Directed non-sales queries to relevant team',
  cr9:  'All client questions answered accurately',
  cr10: 'Converted lead without pushing (no pressure tactics)',
};

// ── Fetch the calling process's own locked parameters. Falls back to the
//    legacy sales scorecard if the process has none stored. ───────────────
async function getProcessParams(db, processId) {
  try {
    const snap = await db.ref(`processList/${processId}/parameters`).once('value');
    const custom = snap.exists() ? snap.val() : null;
    if (custom && Object.keys(custom).length) {
      const ncLabels = {}, crLabels = {}, ncPoints = {};
      const NCK = [], CRK = [];
      Object.keys(custom).forEach(id => {
        const p = custom[id];
        if (p.critical) { CRK.push(id); crLabels[id] = p.label; }
        else { NCK.push(id); ncLabels[id] = p.label; ncPoints[id] = Number(p.points) || 0; }
      });
      return { NCK, CRK, ncPoints, ncLabels, crLabels, isLegacy: false };
    }
  } catch (e) {
    console.warn('getProcessParams: falling back to legacy scorecard —', e.message);
  }
  return {
    NCK: LEGACY_NCK, CRK: LEGACY_CRK, ncPoints: LEGACY_NC_POINTS,
    ncLabels: LEGACY_NC_LABELS, crLabels: LEGACY_CR_LABELS, isLegacy: true,
  };
}

function calcScores(scores, ncPoints, NCK, CRK) {
  let earned = 0, total = 0;
  NCK.forEach(k => {
    if (!(k in scores)) return;
    const pts = ncPoints[k] || 0;
    if (scores[k] === 'yes') { earned += pts; total += pts; }
    else if (scores[k] === 'no') { total += pts; }
  });
  const ncPct  = total > 0 ? Math.round(earned / total * 100) : null;
  const fatal  = CRK.some(k => scores[k] === 'no');
  const totPct = fatal ? 0 : ncPct;
  const result = totPct === null ? null
    : fatal         ? 'Fail'
    : totPct >= 85  ? 'Pass'
    : totPct >= 70  ? 'Review'
    :                 'Fail';
  return { ncPct, earned, total, fatal, totPct, result };
}

// Builds the Gemini scoring prompt from whichever parameter set applies
function buildPrompt(NCK, CRK, ncPoints, ncLabels, crLabels) {
  const ncLines = NCK.map(k => `${k}  ${ncLabels[k] && /^\(/.test(ncLabels[k]) ? ncLabels[k] : `(${ncPoints[k]}pts) ${ncLabels[k]}`}`).join('\n');
  const crLines = CRK.map(k => `${k}  ${crLabels[k]}`).join('\n');
  const scoreKeys = [...NCK.map(k => `"${k}":"yes"`), ...CRK.map(k => `"${k}":"yes"`)].join(',');
  const exampleReasonKey = NCK[0] || CRK[0] || 'nc1';

  return `You are an expert BPO Quality Analyst. Analyse the call transcript and score each parameter below.

SCORING RULES:
- NC (Non-Critical): score "yes", "no", or "na" (not applicable)
- CR (Critical): score "yes" or "no" ONLY — any "no" = FATAL FAIL
- "na" = parameter genuinely not applicable to this call

NON-CRITICAL PARAMETERS (point-weighted):
${ncLines || '(none defined for this process)'}

CRITICAL PARAMETERS (any "no" = FATAL FAIL — score becomes 0%):
${crLines || '(none defined for this process)'}

IMPORTANT: Return ONLY valid JSON with no markdown, no explanation, no extra text.
Use exactly this structure:
{
  "scores": { ${scoreKeys} },
  "reasons": {
    "${exampleReasonKey}": "Short reason if this parameter failed or is notable"
  },
  "callSummary": "2-3 sentence summary of the call",
  "agentStrengths": "One sentence about what the agent did well",
  "coachingTips": [
    "Specific actionable tip 1",
    "Specific actionable tip 2"
  ],
  "confidence": 0.85
}`;
}

module.exports = async (req, res) => {
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { callKey, processId, transcript } = req.body;
  if (!callKey || !processId || !transcript) {
    return res.status(400).json({ error: 'callKey, processId, transcript required' });
  }

  const db      = getDb();
  const callRef = db.ref(`processes/${processId}/calls/${callKey}`);

  try {
    await callRef.update({ status: 'ai_scoring' });

    // ── Load this process's own locked parameter set ─────────────────────
    const { NCK, CRK, ncPoints, ncLabels, crLabels, isLegacy } = await getProcessParams(db, processId);
    const SCORECARD_PROMPT = buildPrompt(NCK, CRK, ncPoints, ncLabels, crLabels);

    // ── Call Google Gemini Flash (FREE) ─────────────────────────────────────
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY environment variable not set');

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: SCORECARD_PROMPT + '\n\nCALL TRANSCRIPT:\n' + transcript
            }]
          }],
          generationConfig: {
            temperature:     0.1,
            maxOutputTokens: 1500,
          },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini API ${geminiRes.status}: ${errText}`);
    }

    const geminiData = await geminiRes.json();
    const rawText    = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText) throw new Error('Gemini returned empty response');

    // ── Parse JSON response ────────────────────────────────────────────────
    let parsed;
    try {
      // Strip any markdown code fences Gemini might add
      const clean = rawText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      // Try extracting JSON if there's text around it
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Gemini returned invalid JSON: ' + rawText.slice(0, 300));
      }
    }

    // ── Calculate scores against THIS process's parameter weights ─────────
    const { ncPct, earned, total, fatal, totPct, result } = calcScores(parsed.scores || {}, ncPoints, NCK, CRK);

    const aiSuggestions = {
      scores:         parsed.scores         || {},
      reasons:        parsed.reasons        || {},
      callSummary:    parsed.callSummary    || '',
      agentStrengths: parsed.agentStrengths || '',
      coachingTips:   parsed.coachingTips   || [],
      confidence:     parsed.confidence     || 0.8,
      ncScore:        ncPct,
      ncEarned:       earned,
      ncTotal:        total,
      crFatal:        fatal,
      totalScore:     totPct,
      result,
      scoredAgainst:  isLegacy ? 'legacy-sales-scorecard' : 'process-parameters',
    };

    await callRef.update({
      aiSuggestions,
      status:      'pending_review',
      aiScoredAt:  new Date().toISOString(),
    });

    return res.status(200).json({
      success:    true,
      totalScore: totPct,
      result,
      fatal,
    });

  } catch (error) {
    console.error('AI scoring error:', error);
    await callRef.update({
      status: 'ai_scoring_failed',
      error:  error.message,
    }).catch(() => {});
    return res.status(500).json({ error: error.message });
  }
};

// ★ Extra headroom for the Gemini call — cheap insurance against slow responses.
module.exports.config = { maxDuration: 60 };
