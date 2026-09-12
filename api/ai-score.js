const admin = require('firebase-admin');
const { withRetry, sendFailureAlert, waitForGeminiSlot } = require('./_lib/reliability');

/**
 * QA.Hub — AI Scoring via Google Gemini Flash
 * Scores each transcript against the calling process's own parameter set.
 */

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

const LEGACY_NC_POINTS = {
  nc1: 10, nc2: 10, nc3: 5, nc4: 10, nc5: 10, nc6: 10,
  nc7: 10, nc8: 10, nc9: 5, nc10: 5, nc11: 10, nc12: 5,
};
const LEGACY_NCK = Object.keys(LEGACY_NC_POINTS);
const LEGACY_CRK = ['cr1','cr2','cr3','cr4','cr5','cr6','cr7','cr8','cr9','cr10'];

const LEGACY_NC_LABELS = {
  nc1: '(10pts) Standard opening & customer name confirmation',
  nc2: '(10pts) Summarization — agent summarised the issue',
  nc3: '(5pts) Further assistance offered before closing',
  nc4: '(10pts) Prescribed call closing used',
  nc5: '(10pts) Paraphrasing — repeated back to confirm understanding',
  nc6: '(10pts) Customer VOC understood and acknowledged',
  nc7: '(10pts) Relevant probing questions asked',
  nc8: '(10pts) Active Listening / Reading demonstrated',
  nc9: '(5pts) Hold and Dead Air SLA followed (<30s hold with permission)',
  nc10: '(5pts) Apologies, Empathy, and Politeness demonstrated',
  nc11: '(10pts) Conversation without overlapping or interruptions',
  nc12: '(5pts) Accurate email sent to client (if applicable)',
};
const LEGACY_CR_LABELS = {
  cr1: 'Agent remained professional, polite, and pleasant throughout',
  cr2: 'Called client within timeframe & accommodated callback per global timezone',
  cr3: 'Provided complete and accurate information',
  cr4: 'Answered queries timely and effectively; chose right disposition',
  cr5: 'Asked qualifying questions and updated notes per standard procedure',
  cr6: 'Successfully created an opportunity after the conversation',
  cr7: 'Updated special requirements in notes for other teams',
  cr8: 'Directed non-sales queries to relevant team',
  cr9: 'All client questions answered accurately',
  cr10: 'Converted lead without pushing (no pressure tactics)',
};

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
  const ncPct = total > 0 ? Math.round(earned / total * 100) : null;
  const fatal = CRK.some(k => scores[k] === 'no');
  const totPct = fatal ? 0 : ncPct;
  const result = totPct === null ? null : fatal ? 'Fail' : totPct >= 85 ? 'Pass' : totPct >= 70 ? 'Review' : 'Fail';
  return { ncPct, earned, total, fatal, totPct, result };
}

function buildPrompt(NCK, CRK, ncPoints, ncLabels, crLabels) {
  const ncLines = NCK.map(k => `${k} ${ncLabels[k] && /^\(/.test(ncLabels[k]) ? ncLabels[k] : `(${ncPoints[k]}pts) ${ncLabels[k]}`}`).join('\n');
  const crLines = CRK.map(k => `${k} ${crLabels[k]}`).join('\n');
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

  const { callKey, processId, transcript } = req.body || {};
  if (!callKey || !processId || !transcript) {
    return res.status(400).json({ error: 'callKey, processId, transcript required' });
  }

  const db = getDb();
  const callRef = db.ref(`processes/${processId}/calls/${callKey}`);

  try {
    await callRef.update({ status: 'ai_scoring', error: null });

    const { NCK, CRK, ncPoints, ncLabels, crLabels, isLegacy } = await getProcessParams(db, processId);
    const SCORECARD_PROMPT = buildPrompt(NCK, CRK, ncPoints, ncLabels, crLabels);

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY environment variable not set');

    // Scale the token budget with the parameter count so a large scorecard
    // (many params + per-param reasons + summary + coaching tips) can't
    // silently truncate mid-JSON. Base covers summary/coaching/confidence;
    // ~120 tokens per parameter covers its score + a short reason.
    const paramCount = NCK.length + CRK.length;
    const dynamicMaxTokens = Math.min(8192, Math.max(2048, 1200 + paramCount * 120));

    // Free-tier pacing: claim a spaced-out slot before calling Gemini so a
    // burst of calls (e.g. several uploaded at once) doesn't all hit the
    // API in the same second and trip the per-minute quota.
    await waitForGeminiSlot(db, { minIntervalMs: 3200 });

    // Current production Gemini Flash model. Google currently lists Gemini 3.6 Flash as GA.
    const geminiData = await withRetry(async () => {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: SCORECARD_PROMPT + '\n\nCALL TRANSCRIPT:\n' + transcript }] }],
            generationConfig: {
              maxOutputTokens: dynamicMaxTokens,
              responseMimeType: 'application/json',
            },
          }),
        }
      );
      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        const err = new Error(`Gemini API ${geminiRes.status}: ${errText}`);
        err.status = geminiRes.status;
        throw err;
      }
      return geminiRes.json();
    }, { retries: 1, baseDelayMs: 1500, maxDelayMs: 35000, label: 'Gemini scoring' });
    const finishReason = geminiData.candidates?.[0]?.finishReason;
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('Gemini returned empty response');
    if (finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini hit the token limit before finishing — response was truncated');
    }

    let parsed;
    try {
      const clean = rawText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Gemini returned invalid JSON: ' + rawText.slice(0, 300));
    }

    const { ncPct, earned, total, fatal, totPct, result } = calcScores(parsed.scores || {}, ncPoints, NCK, CRK);

    const aiSuggestions = {
      scores: parsed.scores || {},
      reasons: parsed.reasons || {},
      callSummary: parsed.callSummary || '',
      agentStrengths: parsed.agentStrengths || '',
      coachingTips: parsed.coachingTips || [],
      confidence: parsed.confidence || 0.8,
      ncScore: ncPct,
      ncEarned: earned,
      ncTotal: total,
      crFatal: fatal,
      totalScore: totPct,
      result,
      scoredAgainst: isLegacy ? 'legacy-sales-scorecard' : 'process-parameters',
    };

    await callRef.update({
      aiSuggestions,
      status: 'pending_review',
      aiScoredAt: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, totalScore: totPct, result, fatal });

  } catch (error) {
    console.error('AI scoring error:', error);
    await callRef.update({ status: 'ai_scoring_failed', error: error.message }).catch(() => {});
    await sendFailureAlert({
      stage: 'ai_scoring', callKey, processId, errorMessage: error.message,
    }).catch(() => {});
    return res.status(500).json({ error: error.message });
  }
};

module.exports.config = { maxDuration: 60 };
