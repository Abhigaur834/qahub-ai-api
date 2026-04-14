/**
 * QA.Hub — AI Scoring via Claude
 * Scores a transcript against the 22-parameter QA scorecard.
 * Output maps directly to the dashboard's CS object format.
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

// ── Scoring weights (mirrors dashboard PM object) ────────────────────────────
const NC_POINTS = {
  nc1: 10, nc2: 10, nc3: 5,  nc4: 10,
  nc5: 10, nc6: 10, nc7: 10,
  nc8: 10, nc9: 5,  nc10: 5, nc11: 10, nc12: 5,
};
const NCK = Object.keys(NC_POINTS);
const CRK = ['cr1','cr2','cr3','cr4','cr5','cr6','cr7','cr8','cr9','cr10'];

function calcScores(scores) {
  let earned = 0, total = 0;
  NCK.forEach(k => {
    if (!(k in scores)) return;
    const pts = NC_POINTS[k];
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

const SCORECARD_PROMPT = `You are an expert BPO Quality Analyst. Analyse the call transcript below and score each parameter.

SCORING RULES:
- NC (Non-Critical) parameters: score Y (yes), N (no), or NA (not applicable)
- CR (Critical) parameters: score Y or N only — any N = automatic FATAL FAIL
- NA means the parameter was genuinely not applicable to this call

NON-CRITICAL PARAMETERS (point-weighted):
nc1  (10pts) Standard opening & customer name confirmation
nc2  (10pts) Summarization — agent summarised the issue
nc3  (5pts)  Further assistance offered before closing
nc4  (10pts) Prescribed call closing used
nc5  (10pts) Paraphrasing — agent repeated back to confirm understanding
nc6  (10pts) Customer VOC understood and acknowledged
nc7  (10pts) Relevant probing questions asked
nc8  (10pts) Active Listening / Reading demonstrated
nc9  (5pts)  Hold and Dead Air SLA followed (<30s hold with permission)
nc10 (5pts)  Apologies, Empathy, and Politeness demonstrated
nc11 (10pts) Conversation without overlapping or interruptions
nc12 (5pts)  Accurate email sent to client (if applicable)

CRITICAL PARAMETERS (any N = FATAL FAIL — score 0%):
cr1  Agent remained professional, polite, and pleasant throughout
cr2  Called client within timeframe & accommodated callback per global timezone
cr3  Provided complete and accurate information
cr4  Answered queries timely and effectively; chose right disposition
cr5  Asked qualifying questions and updated notes per standard procedure
cr6  Successfully created an opportunity after the conversation
cr7  Updated special requirements in notes for other teams
cr8  Directed non-sales queries to relevant team
cr9  All client questions answered accurately
cr10 Converted lead without pushing (no pressure tactics)

Respond ONLY with valid JSON in this exact format — no markdown, no explanation:
{
  "scores": {
    "nc1":"yes","nc2":"yes","nc3":"na","nc4":"yes","nc5":"yes",
    "nc6":"yes","nc7":"no","nc8":"yes","nc9":"na","nc10":"yes",
    "nc11":"yes","nc12":"na",
    "cr1":"yes","cr2":"na","cr3":"yes","cr4":"yes","cr5":"yes",
    "cr6":"yes","cr7":"na","cr8":"na","cr9":"yes","cr10":"yes"
  },
  "reasons": {
    "nc7": "Agent did not ask any probing questions about the client's budget",
    "cr3": "Agent provided correct pricing information"
  },
  "callSummary": "2-3 sentence summary of what happened on this call",
  "agentStrengths": "One sentence about what the agent did well",
  "coachingTips": [
    "Specific actionable coaching tip 1",
    "Specific actionable coaching tip 2"
  ],
  "confidence": 0.85
}`;

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

    // ── Call Claude API ──────────────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system:     SCORECARD_PROMPT,
        messages: [{
          role:    'user',
          content: `Score this call transcript:\n\n${transcript}`,
        }],
      }),
    });

    if (!claudeRes.ok) {
      throw new Error(`Claude API ${claudeRes.status}: ${await claudeRes.text()}`);
    }

    const claudeData = await claudeRes.json();
    const rawText    = claudeData.content?.[0]?.text || '';

    // ── Parse JSON response ──────────────────────────────────────────────────
    let parsed;
    try {
      const clean = rawText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      // Try extracting JSON from response if Claude added text around it
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Claude returned invalid JSON: ' + rawText.slice(0, 200));
      }
    }

    // ── Calculate scores ─────────────────────────────────────────────────────
    const { ncPct, earned, total, fatal, totPct, result } = calcScores(parsed.scores || {});

    const aiSuggestions = {
      scores:        parsed.scores        || {},
      reasons:       parsed.reasons       || {},
      callSummary:   parsed.callSummary   || '',
      agentStrengths:parsed.agentStrengths|| '',
      coachingTips:  parsed.coachingTips  || [],
      confidence:    parsed.confidence    || 0.8,
      ncScore:       ncPct,
      ncEarned:      earned,
      ncTotal:       total,
      crFatal:       fatal,
      totalScore:    totPct,
      result,
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
