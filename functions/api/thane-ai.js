/**
 * Cloudflare Pages Function: POST /api/thane-ai — the Thane page's AI opponent asks a language model for its turn.
 * Master copy: gkk-cards tools/ai/thane-ai-function.js; deployed copy: brozo-website functions/api/thane-ai.js (keep them
 * the same file). Also imported by tools/ai/dev-server.mjs and tools/ai/play.mjs.
 *
 * Request  { model: 'gemini' | 'claude', state: string, actions: string[] }, header x-thane-passcode.
 * Response { plan: number[], why: string }  or  { error: code } with an HTTP status.
 * Environment: GEMINI_API_KEY, ANTHROPIC_API_KEY, THANE_AI_PASSCODE (required), THANE_AI_DAILY_CALLS (default 500),
 * KV binding THANE_AI_KV (optional but recommended: the reliable daily count).
 * The request body is never logged.
 */
export const MODELS = { gemini: 'gemini-3.5-flash-lite', claude: 'claude-haiku-5-5' };
export const LIMITS = { body: 24000, state: 12000, actions: 160, action: 240, outTokens: 300, timeoutMs: 15000 };
export const SYSTEM = [
  'You play the card game Thane against a human. You are "you" in the table text.',
  'Rules: each side has a Thane (health is the score; at 0 you lose) and three lanes. A fighter faces the fighter in the same lane.',
  'Each fighter may attack once a turn, not on the turn it arrives and not on the first turn of the match. The small attack is free; the big attack costs AP (Action Points).',
  'A fighter whose opposite lane is empty may instead make its small attack on their Thane (an open lane). Nothing else reaches a Thane, except card or ability texts that say so.',
  'When a fighter card is destroyed its Thane loses the kill cost shown (4 to 6). Made fighters (Recruit, Sandbag) cost little or nothing. Walls/Barricades cannot attack but close a lane.',
  'Once a turn your Thane may use one ability, paying its own health; if it uses none it rests at the end of your turn (+1 health) but only while below 10 health. A rest swap replaces the rest at no health.',
  'AP (Action Points): your pool grows by 1 each turn and refills. Unspent AP stays through their turn for one instant when you are attacked. Once a turn you may discard a card to draw one. At most 8 cards in hand when your turn ends.',
  'AP does NOT bank: the pool refills each turn, so AP left at the end of your turn is only useful for an instant during their turn. Spend it.',
  'Good play: fill empty lanes with fighters every turn you can (an empty lane lets their fighter hit your Thane each turn); attack with every ready fighter each turn, big attack when you can pay; finish damaged fighters (each kill costs their Thane 4-6); hit their Thane through open lanes; use the Thane ability when it gains more than the health it costs; keep a cheap instant only if AP is left over.',
  'The table changes after each action, so list attacks after the plays that set them up, and end the turn last.',
  'Reply with JSON only: {"plan": [action numbers in the order you want them, for the whole rest of this turn, usually ending with the "end the turn" action], "why": "one short line"}.',
  'Use only numbers from the list. Later actions may change after earlier ones resolve; list what you intend anyway.',
].join('\n');

/** The user message the model reads. */
export const userText = (state, actions) => `${state}\n\nLEGAL ACTIONS NOW:\n${actions.map((t, k) => `${k}: ${t}`).join('\n')}`;

const SCHEMA = { type: 'object', properties: { plan: { type: 'array', items: { type: 'integer' } }, why: { type: 'string' } }, required: ['plan', 'why'], additionalProperties: false };

async function withTimeout(url, init, ms) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}
const err = (code, status) => Object.assign(new Error(code), { code, status });

/** Calls a provider. Returns { reply: {plan, why} | null, usage: { input, output, thinking }, raw }. */
export async function callModel(which, key, state, actions, { timeoutMs = LIMITS.timeoutMs, fetchImpl } = {}) {
  const f = fetchImpl || withTimeout, user = userText(state, actions);
  let res;
  try {
    if (which === 'gemini') {
      res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, maxOutputTokens: LIMITS.outTokens, thinkingConfig: { thinkingLevel: 'minimal' } } }),
      }, timeoutMs);
    } else {
      res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODELS.claude, max_tokens: LIMITS.outTokens, system: SYSTEM, messages: [{ role: 'user', content: user }],
          thinking: { type: 'disabled' }, output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } }),
      }, timeoutMs);
    }
  } catch (e) { throw err(e && e.name === 'AbortError' ? 'timeout' : 'upstream_unreachable', e && e.name === 'AbortError' ? 504 : 502); }
  if (!res.ok) { let detail = ''; try { detail = (await res.text()).slice(0, 300); } catch { /* none */ } throw Object.assign(err('upstream_error', 502), { upstreamStatus: res.status, detail }); }
  const j = await res.json();
  let text = '', usage;
  if (which === 'gemini') {
    text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map((p) => p.text || '').join('');
    const u = j.usageMetadata || {}; usage = { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, thinking: u.thoughtsTokenCount || 0 };
  } else {
    if (j.stop_reason === 'refusal') throw err('refused', 502);
    text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const u = j.usage || {}; usage = { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, thinking: 0 };
  }
  let reply = null; try { reply = JSON.parse(text); } catch { /* invalid */ }
  return { reply, usage, raw: text };
}

/** Request checks: returns { model, state, actions } or throws err(code, status). */
export function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw err('bad_request', 400);
  const keys = Object.keys(body);
  if (keys.some((k) => !['model', 'state', 'actions'].includes(k))) throw err('bad_request', 400);
  const { model, state, actions } = body;
  if (!Object.hasOwn(MODELS, model)) throw err('bad_model', 400);
  if (typeof state !== 'string' || !state.length || state.length > LIMITS.state) throw err('bad_state', 400);
  if (!Array.isArray(actions) || !actions.length || actions.length > LIMITS.actions || actions.some((a) => typeof a !== 'string' || !a.length || a.length > LIMITS.action)) throw err('bad_actions', 400);
  return { model, state, actions };
}
/** Same text, compared in constant time over SHA-256 digests. */
export async function sameSecret(a, b) {
  const enc = new TextEncoder(), [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0;
  for (let k = 0; k < u.length; k++) d |= u[k] ^ v[k];
  return d === 0;
}
// fallback count when no KV is bound: per isolate only (Cloudflare runs many, and restarts them), so NOT a reliable cap
const memory = { day: '', n: 0 };
async function countCall(env, now = new Date()) {
  const day = now.toISOString().slice(0, 10), cap = Number(env.THANE_AI_DAILY_CALLS) || 500;
  if (env.THANE_AI_KV) {
    const k = `calls:${day}`, n = Number(await env.THANE_AI_KV.get(k)) || 0;
    if (n >= cap) return false;
    await env.THANE_AI_KV.put(k, String(n + 1), { expirationTtl: 3 * 86400 });   // read-then-write: a burst may overshoot by a few
    return true;
  }
  if (memory.day !== day) { memory.day = day; memory.n = 0; }
  if (memory.n >= Math.min(cap, 100)) return false;
  memory.n++; return true;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const origin = request.headers.get('origin'), self = new URL(request.url).origin;
    if (!origin || origin !== self) return json({ error: 'bad_origin' }, 403);
    if (!env.THANE_AI_PASSCODE) return json({ error: 'not_configured' }, 503);
    if (!(await sameSecret(request.headers.get('x-thane-passcode') || '', env.THANE_AI_PASSCODE))) return json({ error: 'bad_passcode' }, 401);
    if (Number(request.headers.get('content-length') || 0) > LIMITS.body) return json({ error: 'too_large' }, 413);
    const raw = await request.text();
    if (raw.length > LIMITS.body) return json({ error: 'too_large' }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }
    const { model, state, actions } = validate(body);
    const key = model === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
    if (!key) return json({ error: 'model_not_configured' }, 503);
    if (!(await countCall(env))) return json({ error: 'daily_cap' }, 429);
    const { reply } = await callModel(model, key, state, actions);
    if (!reply || !Array.isArray(reply.plan)) return json({ error: 'bad_model_reply' }, 502);
    const plan = reply.plan.filter((k) => Number.isInteger(k) && k >= 0 && k < actions.length).slice(0, 40);
    return json({ plan, why: typeof reply.why === 'string' ? reply.why.slice(0, 160) : '' });
  } catch (e) {
    return json({ error: e.code || 'internal' }, e.status || 500);   // no request body, no key, no upstream detail goes back or into logs
  }
}
export const _test = { memory, countCall };
