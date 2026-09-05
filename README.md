# pi-asterlab-provider

A [pi](https://github.com/earendil-works/pi-mono) extension that registers
**[AsterLab](https://www.asterlab.ai)** as a model provider, backed by
AsterLab's OpenAI-compatible Chat Completions API
(`https://api.asterlab.ai/v1`).

## Features

- **Runtime model discovery.** Ids, per-million pricing (including cached-input
  rates), and advertised context lengths come from AsterLab's keyless
  `/v1/models` endpoint, so the provider never pins a rotating model list.
- **Live verification of every listed model.** AsterLab's listing leads real
  availability: `gpt-oss-120b` and `gpt-oss-120b-fast` are listed but answer
  every request shape with HTTP 404. When `$ASTERLAB_API_KEY` is set at load
  time each model gets one 8-token chat request; ids AsterLab definitively
  refuses (4xx) are dropped and the reason is logged. Transient failures
  (429/5xx/network) keep the model rather than emptying the catalog. The same
  probe *measures* reasoning support from the response instead of guessing it
  from the id.
- **Context windows are exactly what AsterLab reports — and that was verified.**
  `/v1/models` advertises `context_length: 1048576` for `glm-5.2` and
  `kimi-k3`, and live probes confirm AsterLab really serves it: 1,047,626
  prompt tokens on `glm-5.2` and 1,039,708 on `kimi-k3` both returned HTTP 200,
  while ~1.1M tokens was refused. Nothing is clamped or invented, so the number
  in pi's picker matches the dashboard. See
  [Request size limits](#request-size-limits) for the two separate ceilings that
  sit below it, and [Adjusting the context window](#adjusting-the-context-window)
  if you want pi to compact earlier anyway.
- **Auto-compaction on AsterLab's payload cap.** AsterLab's 413 body
  (`Request Entity Too Large`) matches none of pi's overflow patterns, so a
  `message_end` handler rewrites it to pi's generic `context_length_exceeded`
  prefix. pi then drops the failed message, compacts, and retries once. The 400
  and 504 that the same limits can produce are deliberately left alone — see
  [Request size limits](#request-size-limits).
- **`/login asterlab` support.** Prompts for and stores your AsterLab API key,
  with `ASTERLAB_API_KEY` as an automatic fallback.
- **Requests sent the way AsterLab's upstreams expect:**
  - `Authorization: Bearer <key>`
  - `system` role. AsterLab accepts `developer`, but it proxies to Z.AI and
    Moonshot, whose own pi catalogs both use `system`.
  - `max_tokens` (both fields are accepted; this is what the upstreams use)
  - `reasoning_effort` for reasoning models, with pi's `off` mapped to `"none"`
    (verified to zero out `reasoning_tokens`). AsterLab accepts the full
    `none/minimal/low/medium/high/xhigh/max` range and rejects anything else.
  - `stream_options.include_usage` (verified: usage arrives in the final chunk)
  - Streamed `reasoning_content` deltas are parsed into pi thinking blocks by
    the built-in `openai-completions` API
  - No `store`, no tool `strict`, no `prompt_cache_retention`, and no Anthropic
    `cache_control` markers — caching on AsterLab is implicit (a repeated prompt
    returns `cached_tokens` with nothing extra sent), so the cached-input rate
    maps to `cost.cacheRead` and no cache parameters are emitted.

## Install

### As a pi package (recommended)

```sh
pi install git:github.com/perezdap/pi-asterlab-provider
```

This clones the repo and registers the extension from the `pi` manifest in
`package.json`. Run `pi update --extensions` to pick up new versions.

### Global (all projects), manual

Clone straight into pi's global extensions folder:

```sh
# Windows (PowerShell)
git clone https://github.com/perezdap/pi-asterlab-provider "$env:USERPROFILE\.pi\agent\extensions\asterlab"

# macOS / Linux
git clone https://github.com/perezdap/pi-asterlab-provider ~/.pi/agent/extensions/asterlab
```

Then start (or `/reload`) pi. The extension auto-loads from
`~/.pi/agent/extensions/asterlab/index.ts`.

### Project-local

Clone into `<project>/.pi/extensions/asterlab/` instead. Project-local
extensions load only after the project is trusted.

### Quick test (no install)

```sh
pi -e ./index.ts
```

## Use

```
/login asterlab        # enter your AsterLab API key (or export ASTERLAB_API_KEY first)
/model asterlab/<id>   # e.g. asterlab/glm-5.2, asterlab/kimi-k3
```

Set pi's default model in `settings.json` if desired:

```jsonc
{ "defaultProvider": "asterlab", "defaultModel": "glm-5.2" }
```

To pick up newly added AsterLab models, run `/reload` (the factory re-fetches
`/v1/models` and re-verifies).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ASTERLAB_API_KEY` | API key fallback for `/login asterlab`, and enables live model verification at load time |
| `PI_ASTERLAB_SKIP_VERIFY` | `1`/`true`/`yes` skips the verification probes (no requests spent; reasoning falls back to the family table) |
| `PI_ASTERLAB_CONTEXT_WINDOW` | Optional ceiling, in tokens, on the reported context window. Never raises a window above what AsterLab advertises. See [Adjusting the context window](#adjusting-the-context-window) |

## Request size limits

AsterLab has two ceilings that are **not** context windows. Both were measured
on 2026-09-04 against `glm-5.2`, and both sit below the advertised 1,048,576
token window, so neither is encoded into `contextWindow`.

### 1. A hard 4 MiB request-body cap

| Body size | Result |
| --- | --- |
| 4,194,200 bytes | HTTP 200 |
| 4,194,304 bytes (exactly 4 MiB) | HTTP 200 |
| 4,194,400 bytes (+96 bytes) | HTTP 400 `upstream_error` |
| ~4.3 MB and above | HTTP 413 `FUNCTION_PAYLOAD_TOO_LARGE` |

This is a **byte** limit, so where it bites depends entirely on text density:

| Content | Tokens at the 4 MiB cap |
| --- | --- |
| Prose (~5.7 chars/token) | ~729,000 |
| Dense code-ish filler (~1.95 chars/token) | ~2,100,000 |

A prose-heavy session therefore hits the body cap at ~729k tokens, well before
the 1M window. The 413 spelling is rewritten for auto-compaction; the 400
spelling is not, because AsterLab's 400 body is the same generic
`"The upstream model provider returned an error."` it returns for unrelated
refusals (an unknown model, an image sent to a text-only model), so matching it
would make pi compact on errors that belong to its normal retry path.

### 2. A ~300s serverless function timeout

Very large prompts can return HTTP 504 `FUNCTION_INVOCATION_TIMEOUT` after
roughly 300 seconds. It is **transient and load-dependent**, not a limit on the
model: one probe 504'd at ~660k tokens, and the identical request later
succeeded in seconds. That is exactly why it is not treated as a context window
— labelling an infrastructure timeout as a model capability would be a guess
dressed up as a spec. It is also not rewritten as overflow, for the same reason.

### What this means in practice

With the advertised 1M window, pi will happily build a prompt that AsterLab then
refuses on body size (400) or times out on (504), and neither triggers
auto-compaction. If that matters for your workload, cap the window so pi
compacts before reaching those limits:

```sh
PI_ASTERLAB_CONTEXT_WINDOW=640000
```

640k keeps a prose-heavy session under the 4 MiB body cap with margin. It costs
you real context on the models that can genuinely serve 1M, so it is opt-in
rather than the default.

## Adjusting the context window

Context windows come straight from AsterLab's `context_length` field. To change
what pi reports, set `PI_ASTERLAB_CONTEXT_WINDOW` to a token count:

```sh
# PowerShell
$env:PI_ASTERLAB_CONTEXT_WINDOW = "640000"

# bash
export PI_ASTERLAB_CONTEXT_WINDOW=640000
```

Rules:

- It is a **ceiling**: `min(advertised, ceiling)`. It can never raise a window
  above what AsterLab reports, so it cannot make pi overflow a real limit.
- A non-numeric, zero, or negative value is ignored with a warning, and the
  advertised window stands.
- When it takes effect, the extension logs
  `[asterlab] PI_ASTERLAB_CONTEXT_WINDOW=640000: context windows capped below
  AsterLab's advertised values.` at load time, so the picker number is never a
  mystery.
- `maxTokens` follows: it is capped at the resulting window.
- Change it and run `/reload` to re-fetch and re-apply.

To re-measure AsterLab's real ceiling after a change on their side, probe with a
large prompt and read back `usage.prompt_tokens`:

```sh
curl -s https://api.asterlab.ai/v1/chat/completions \
  -H "Authorization: Bearer $ASTERLAB_API_KEY" -H "Content-Type: application/json" \
  --data-binary @big-prompt.json | jq '.usage.prompt_tokens, .error'
```

## How it works

- **Streaming/API:** uses pi's built-in `openai-completions` API. AsterLab is
  OpenAI-compatible, so no custom streaming code is needed; pi already parses
  `reasoning_content`, tool calls, usage, and `stop` reasons.
- **Auth:** `envApiKeyAuth("AsterLab API key", ["ASTERLAB_API_KEY"])` — stored
  credential wins, then the env var.
- **Model discovery:** `GET /v1/models` (no auth required). Models with no token
  pricing are dropped before probing — `aster/wildflower` is a search model
  priced `per_search_usd`, and AsterLab rejects it with "does not support
  `/v1/chat/completions`".
- **Verification:** one `max_tokens: 8` chat request per remaining model, run
  concurrently under a single 30s budget. 4xx ⇒ excluded and logged; 429/5xx/
  transport failure ⇒ kept, with reasoning assumed from the family table.
- **Display names:** AsterLab's listing has no display name, so ids are mapped
  through the vendors' own capitalizations (`glm-5.2` → `GLM-5.2`, `kimi-k3` →
  `Kimi K3`, `gpt-oss-120b` → `GPT OSS 120B`) with any org prefix kept in
  parens (`zai-org/glm-5.2-batch` → `GLM-5.2 Batch (zai-org)`). Unknown
  families fall back to a title-cased id.
- **Context window:** AsterLab's advertised `context_length`, optionally lowered
  by `PI_ASTERLAB_CONTEXT_WINDOW`. Models that report none fall back to 128k.
  Verified servable end-to-end at 1,047,626 tokens (`glm-5.2`) and 1,039,708
  (`kimi-k3`); ~1.1M tokens is refused.
- **Max output tokens:** not reported by AsterLab, so they come from the
  upstream vendors' own pi catalogs (Z.AI GLM-5.x and Moonshot Kimi K3+ both cap
  at 131072) and were confirmed accepted by a live `max_tokens: 131072` request.
- **Input modalities:** AsterLab exposes none. `kimi-k3` was verified to accept
  `image_url` parts; `glm-5.2` rejected them, so images are advertised only for
  the Kimi vision-capable families.
- **Overflow rewrite:** a `message_end` handler scoped to
  `provider === "asterlab"` and to the `FUNCTION_PAYLOAD_TOO_LARGE` /
  `Request Entity Too Large` phrase. The 400 `upstream_error` and 504
  `FUNCTION_INVOCATION_TIMEOUT` are intentionally not rewritten — see
  [Request size limits](#request-size-limits).

## Notes

- Discovery is keyless, so models load even before `/login`. Requests need a
  key, and so does verification — without one you get the full listing minus
  non-chat models, with a warning that the ids were not checked.
- AsterLab model ids are case-sensitive and differ from the dashboard display
  names (`GLM-5.2` → `glm-5.2`, `Kimi K3` → `kimi-k3`). Discovery plus
  verification is what keeps pi's picker on the real ids.
- The 4 MiB body cap and the ~300s function timeout are infrastructure limits,
  not model limits, and are documented in
  [Request size limits](#request-size-limits) rather than folded into
  `contextWindow`. Re-probe them if AsterLab changes its deployment.
- This is intentionally a pi **chat provider**, not a client for every AsterLab
  surface. Only `/v1/models` and `/v1/chat/completions` exist; `/v1/responses`,
  `/v1/embeddings`, and `/v1/completions` all return 404.
- For gateway-routed usage (logging, caching, rate limiting through Cloudflare
  AI Gateway) see the `asterlab-models-sync` skill, which writes a
  `models.json` provider instead of registering an extension.

## Test

```sh
npm install
npm test                              # live discovery + verification probes
PI_ASTERLAB_SKIP_VERIFY=1 npm test    # mapping assertions only, no requests spent
PI_ASTERLAB_CONTEXT_WINDOW=640000 npm test   # exercises the optional ceiling
npm run typecheck
```

The test loads the real extension against the live API and asserts provider
registration, per-model mapping (pricing, context window against the live
listing, compat flags, thinking levels), non-chat and uncallable-model
exclusion, display names, the `message_end` overflow rewrite (including its
scoping, idempotence, and the 400/504/429 errors it must *not* touch), the
`/login` + env-fallback auth flow, and the `PI_ASTERLAB_CONTEXT_WINDOW` ceiling
(lowers windows, never raises them, rejects invalid values, reports itself).
