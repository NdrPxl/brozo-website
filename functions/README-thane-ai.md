# Thane AI opponent: server function

`functions/api/thane-ai.js` answers `POST /api/thane-ai` for the Thane page (brozo.co/thane/). The page sends the table
as text and the list of legal moves; the function asks a language model and returns only the move numbers and a short
reason. The keys stay here, never in the page. Master copy: gkk-cards `tools/ai/thane-ai-function.js` (copy it over
when it changes).

Cloudflare Pages builds `functions/` automatically on push. Until the settings below exist the function answers
`503 not_configured` and the page quietly falls back to the built-in computer player.

## What to set in the Cloudflare dashboard

In the Pages project of this site: Settings, then Variables and Secrets (Production; also Preview if wanted):

| Name | Type | Value |
|---|---|---|
| `THANE_AI_PASSCODE` | Secret | the passcode testers type once (required: without it every call is refused) |
| `GEMINI_API_KEY` | Secret | the Gemini API key (the one called Gemini_Thane_API in the hub's .env) |
| `ANTHROPIC_API_KEY` | Secret | an Anthropic API key for the Claude choice (best a key of its own with its own monthly limit) |
| `THANE_AI_DAILY_CALLS` | Text (optional) | most model calls per UTC day, default 500 (a match uses about 10 to 15) |

Then in the same project: Settings, then Bindings, add a **KV namespace** binding named `THANE_AI_KV` (create a KV
namespace first under Storage, any name, e.g. `thane-ai`). It holds the per-day call count. Without it the function
counts in memory per worker instance, which is not a reliable cap (Cloudflare runs and restarts many instances); it
then also limits itself to at most 100 calls per instance per day.

A new deployment (push, or "Retry deployment") is needed after changing variables or bindings.

## Spend caps at the providers (recommended, the real backstop)

- Google AI Studio: the project of the Gemini key, Spend page: set a monthly cap (a few dollars is plenty).
- Anthropic Console: give the key its own workspace or a monthly spend limit.

## Guards in the function

POST only; the `Origin` must be this site; passcode in the `x-thane-passcode` header compared in constant time; body
at most 24 KB, state at most 12,000 characters, at most 160 moves of 240 characters, only the keys `model`, `state`,
`actions`; model `gemini` (gemini-3.5-flash-lite) or `claude` (claude-haiku-5-5); at most 300 output tokens; 15 s
timeout to the provider; returns only `{ plan, why }`. Errors: 400 bad_request / bad_json / bad_model / bad_state /
bad_actions, 401 bad_passcode, 403 bad_origin, 405 method_not_allowed, 413 too_large, 429 daily_cap,
502 upstream_error / bad_model_reply / refused, 503 not_configured / model_not_configured, 504 timeout.
The request body is never logged.
