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
- **Context windows clamped to what AsterLab actually serves.** `/v1/models`
  advertises `context_length: 1048576` for `glm-5.2` and `kimi-k3`, but live
  probes show 639,403 prompt tokens succeeding in ~115s while ~660k tokens hits
  AsterLab's ~300s serverless timeout (HTTP 504 `FUNCTION_INVOCATION_TIMEOUT`),
  and any request body over ~4.2MB fails outright with HTTP 413
  `FUNCTION_PAYLOAD_TOO_LARGE`. Declaring the un-servable 1M would let pi walk
  into a five-minute hang, so windows are clamped to 640k.
- **Auto-compaction on AsterLab's payload cap.** AsterLab's 413 body
  (`Request Entity Too Large`) matches none of pi's overflow patterns, so a
  `message_end` handler rewrites it to pi's generic `context_length_exceeded`
  prefix. pi then drops the failed message, compacts, and retries once. The
  504 timeout is deliberately left alone — it is a serverless timeout, not a
  definitive overflow.
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
- **Max output tokens:** not reported by AsterLab, so they come from the
  upstream vendors' own pi catalogs (Z.AI GLM-5.x and Moonshot Kimi K3+ both cap
  at 131072) and were confirmed accepted by a live `max_tokens: 131072` request.
- **Input modalities:** AsterLab exposes none. `kimi-k3` was verified to accept
  `image_url` parts; `glm-5.2` rejected them, so images are advertised only for
  the Kimi vision-capable families.
- **Overflow rewrite:** a `message_end` handler scoped to
  `provider === "asterlab"` and to the `FUNCTION_PAYLOAD_TOO_LARGE` /
  `Request Entity Too Large` phrase.

## Notes

- Discovery is keyless, so models load even before `/login`. Requests need a
  key, and so does verification — without one you get the full listing minus
  non-chat models, with a warning that the ids were not checked.
- AsterLab model ids are case-sensitive and differ from the dashboard display
  names (`GLM-5.2` → `glm-5.2`, `Kimi K3` → `kimi-k3`). Discovery plus
  verification is what keeps pi's picker on the real ids.
- The 640k clamp in `MAX_SERVABLE_PROMPT_TOKENS` is a measured ceiling, not a
  model limit. Re-probe and raise it if AsterLab lifts the function timeout or
  the payload cap.
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
npm run typecheck
```

The test loads the real extension against the live API and asserts provider
registration, per-model mapping (pricing, context clamp, compat flags, thinking
levels), non-chat and uncallable-model exclusion, display names, the
`message_end` overflow rewrite (including its scoping, idempotence, and the
errors it must *not* touch), and the `/login` + env-fallback auth flow.
