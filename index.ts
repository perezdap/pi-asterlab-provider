/**
 * AsterLab provider extension for pi.
 *
 * Registers the "asterlab" provider against AsterLab's OpenAI-compatible Chat
 * Completions API (https://api.asterlab.ai/v1). The catalog — ids, per-million
 * pricing including cached-input rates, and advertised context lengths — is
 * discovered at runtime from AsterLab's keyless /v1/models endpoint, so the
 * provider never pins a rotating model list.
 *
 * AsterLab's listing carries no capability metadata (no supported_endpoints, no
 * architecture, no reasoning flags), so this extension recovers what it can:
 *
 *   - Non-chat models are dropped by pricing shape. `aster/wildflower` is a
 *     search model priced `per_search_usd` with no token pricing, and AsterLab
 *     rejects it with "does not support /v1/chat/completions".
 *   - When $ASTERLAB_API_KEY is set at load time, every remaining model is
 *     verified with one 8-token chat request. Models AsterLab definitively
 *     refuses (4xx) are excluded and reported, because the listing leads real
 *     availability: as of this writing `gpt-oss-120b` and `gpt-oss-120b-fast`
 *     are listed but answer every request shape with HTTP 404 "The upstream
 *     model provider returned an error." Transient failures (429/5xx/network)
 *     keep the model instead of dropping it. The same probe measures reasoning
 *     from the response (`reasoning_content` present, or `reasoning_tokens > 0`)
 *     rather than guessing it from the id.
 *   - Without a key the probe is skipped (discovery itself is keyless) and
 *     reasoning falls back to a model-family table. Set
 *     PI_ASTERLAB_SKIP_VERIFY=1 to skip probing even when a key is available.
 *
 * Auth: `/login asterlab` prompts for an AsterLab API key and stores it, with
 * $ASTERLAB_API_KEY as an automatic fallback. Requests are sent the way
 * AsterLab's upstreams (Z.AI, Moonshot) expect:
 *
 *   - `Authorization: Bearer <key>` (resolved by openai-completions + envApiKeyAuth)
 *   - `system` role (compat.supportsDeveloperRole = false). AsterLab accepts
 *     `developer`, but both upstream vendors' own pi catalogs use `system`.
 *   - `max_tokens` (both fields are accepted; this is what the upstreams use)
 *   - `reasoning_effort` for reasoning models, with pi's "off" mapped to "none"
 *     (verified to zero out `reasoning_tokens`). AsterLab accepts the full
 *     none/minimal/low/medium/high/xhigh/max range and rejects anything else.
 *   - `stream_options.include_usage` (verified: usage arrives in the final chunk)
 *   - No `store`, no tool `strict`, no `prompt_cache_retention`, and no
 *     Anthropic `cache_control` markers. Caching on AsterLab is implicit — a
 *     repeated prompt returns `cached_tokens` with no markers sent — so the
 *     cached-input rate maps to cost.cacheRead and nothing extra is sent.
 *
 * Context windows are reported exactly as AsterLab advertises them, because the
 * advertised value was verified servable end-to-end: 1,047,626 prompt tokens on
 * glm-5.2 and 1,039,708 on kimi-k3 both returned HTTP 200, while ~1.1M tokens
 * was refused. Two SEPARATE limits sit below that ceiling and are not context
 * windows, so they are not encoded as one:
 *
 *   - A hard 4 MiB request-body cap. A 4,194,304-byte body succeeds; 96 bytes
 *     more returns HTTP 400 `upstream_error`, and ~4.3MB+ returns HTTP 413
 *     `FUNCTION_PAYLOAD_TOO_LARGE`. This is a byte limit, so where it bites
 *     depends on text density (~729k tokens for prose, ~2.1M for dense code).
 *   - A ~300s serverless function timeout that can return HTTP 504
 *     `FUNCTION_INVOCATION_TIMEOUT` on very large prompts. It is transient and
 *     load-dependent: one probe 504'd at ~660k tokens and the identical request
 *     later succeeded in seconds.
 *
 * A message_end handler rewrites the distinctive 413 payload-too-large body into
 * pi's generic `context_length_exceeded` prefix so pi compacts and retries. The
 * 400 and 504 are deliberately left alone: AsterLab's 400 body carries no
 * detail that distinguishes overflow from any other upstream refusal, and the
 * 504 is a timeout rather than a definitive overflow, so rewriting either would
 * make pi compact on errors that belong to its normal retry path. See
 * PI_ASTERLAB_CONTEXT_WINDOW below for adjusting the reported window.
 *
 * Usage:
 *   /login asterlab        # enter your AsterLab API key (or export ASTERLAB_API_KEY)
 *   /model asterlab/<id>   # e.g. asterlab/glm-5.2, asterlab/kimi-k3
 *
 * Models are refreshed by /reload (re-runs this factory, re-fetches /v1/models).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Model,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const PROVIDER_ID = "asterlab";
const PROVIDER_NAME = "AsterLab";
const ASTERLAB_BASE_URL = "https://api.asterlab.ai/v1";
const ASTERLAB_MODELS_URL = `${ASTERLAB_BASE_URL}/models`;
const ASTERLAB_CHAT_URL = `${ASTERLAB_BASE_URL}/chat/completions`;
const API_KEY_ENV_VAR = "ASTERLAB_API_KEY";

// pi thinking levels in increasing order of effort. AsterLab accepted every one
// of these verbatim on the models probed, and "none" disables thinking.
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Used only when a listed model reports no usable context_length. */
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Optional ceiling on the reported context window, in tokens. AsterLab's
 * advertised context_length was verified servable (1,047,626 tokens -> HTTP 200
 * on glm-5.2), so by default nothing is clamped and the picker shows the real
 * number. Set this only if you want pi to compact earlier than the model's true
 * limit — for example to stay clear of AsterLab's hard 4 MiB request-body cap
 * (4,194,304 bytes succeeds, 96 bytes more returns HTTP 400) or its ~300s
 * serverless timeout on very large prompts:
 *
 *   PI_ASTERLAB_CONTEXT_WINDOW=640000
 *
 * Values are clamped to [1, advertised]; a non-numeric or non-positive value is
 * ignored. See README "Adjusting the context window".
 */
const CONTEXT_WINDOW_ENV_VAR = "PI_ASTERLAB_CONTEXT_WINDOW";

const DISCOVERY_TIMEOUT_MS = 15_000;
/** Budget for the whole parallel verification pass, not per model. */
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_TOKENS = 8;

/**
 * Max output tokens per model family. AsterLab's /v1/models reports no output
 * limit, so these come from the upstream vendors' own pi catalogs (Z.AI GLM-5.2
 * and Moonshot kimi-k3 both cap at 131072) and were confirmed accepted by a live
 * `max_tokens: 131072` request. Matched against the id with any org prefix
 * stripped; first match wins.
 */
const MAX_OUTPUT_OVERRIDES: { pattern: RegExp; maxTokens: number }[] = [
	{ pattern: /^glm-[5-9]/i, maxTokens: 131_072 },
	{ pattern: /^kimi-k[3-9]/i, maxTokens: 131_072 },
	{ pattern: /^gpt-oss-/i, maxTokens: 16_384 },
];

/**
 * Kimi families verified (k3) or documented by Moonshot (k2.5+) as accepting
 * image input. AsterLab's glm-5.2 rejects image_url parts, so GLM stays
 * text-only. AsterLab exposes no input-modality metadata to discover this from.
 */
const VISION_PATTERN = /^kimi-k(?:[3-9]|2\.[5-9])/i;

/**
 * Reasoning families, used only for models that could not be probed (no API key
 * at load time, or a transient probe failure). Every chat model AsterLab has
 * served to date reasons by default.
 */
const REASONING_PATTERNS = [
	/^glm-/i,
	/^kimi-k/i,
	/^gpt-oss-/i,
	/^deepseek-/i,
	/^qwen3/i,
	/^minimax-m/i,
	/^grok-/i,
	/^o[134]/i,
	/^gpt-5/i,
];

/**
 * Display labels for the model families AsterLab serves. The listing has no
 * display name, and the vendors' own capitalizations ("GLM-5.2", "Kimi K3",
 * "GPT OSS 120B") are what users recognize, so known families get their proper
 * label and anything new falls back to a title-cased id.
 *
 * `versionSeparator` is the punctuation each vendor keeps before a numeric
 * version: Z.AI brands it "GLM-5.2", everyone else spaces it out ("Kimi K3").
 */
const FAMILY_LABELS: { pattern: RegExp; label: string; versionSeparator?: string }[] = [
	{ pattern: /^glm/i, label: "GLM", versionSeparator: "-" },
	{ pattern: /^kimi/i, label: "Kimi" },
	{ pattern: /^gpt-oss/i, label: "GPT OSS" },
	{ pattern: /^gpt/i, label: "GPT" },
	{ pattern: /^deepseek/i, label: "DeepSeek" },
	{ pattern: /^qwen/i, label: "Qwen" },
	{ pattern: /^minimax/i, label: "MiniMax" },
	{ pattern: /^grok/i, label: "Grok" },
	{ pattern: /^llama/i, label: "Llama" },
	{ pattern: /^mistral/i, label: "Mistral" },
];

// ---- AsterLab /v1/models response shape (only the fields it actually returns) ----

interface AsterLabPricing {
	input?: number;
	output?: number;
	input_per_million_tokens_usd?: number;
	output_per_million_tokens_usd?: number;
	cached_input_per_million_tokens_usd?: number;
	/** Search-only models (aster/wildflower) are priced per search, not per token. */
	per_search_usd?: number;
}

interface AsterLabModel {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	context_length?: number;
	pricing?: AsterLabPricing;
}

/** Probe outcome. "unknown" keeps the model: only a definitive refusal drops it. */
type ProbeResult =
	| { status: "ok"; reasoning: boolean }
	| { status: "rejected"; reason: string }
	| { status: "unknown"; reason: string };

interface DiscoveredCatalog {
	models: Model<Api>[];
	/** Listed models that were dropped, with the reason (logged at load time). */
	excluded: { id: string; reason: string }[];
	/** True when the probe ran, so `reasoning` is measured rather than assumed. */
	verified: boolean;
	/** The PI_ASTERLAB_CONTEXT_WINDOW ceiling in effect, if any. */
	ceiling?: number;
}

/** Strip an org prefix ("zai-org/glm-5.2-batch" -> "glm-5.2-batch") for matching. */
function bareId(id: string): string {
	const parts = id.split("/");
	return parts[parts.length - 1] ?? id;
}

/** Title-case an id whose family is not in FAMILY_LABELS. */
function titleCase(value: string): string {
	return value.replace(/(^|[-. ])([a-z])/g, (_all, sep: string, char: string) => sep + char.toUpperCase());
}

/**
 * Build a readable picker name: proper family label, version kept verbatim,
 * hyphenated suffixes turned into words, org prefix kept in parens
 * ("zai-org/glm-5.2-batch" -> "GLM-5.2 Batch (zai-org)").
 */
function displayName(id: string): string {
	const org = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : undefined;
	const bare = bareId(id);
	// Family token = leading alphabetic segments, stopping before any segment
	// that carries a version digit ("kimi-k3" -> "kimi", "gpt-oss-120b" -> "gpt-oss").
	const family = bare.match(/^[a-z]+(?:-[a-z]+(?![0-9]))*/i)?.[0] ?? "";
	const entry = FAMILY_LABELS.find(({ pattern }) => pattern.test(bare));
	const label = entry?.label ?? titleCase(family || bare);
	const versionSeparator = entry?.versionSeparator ?? " ";
	// Everything after the family token: keep dots inside versions, use the
	// family's separator before a numeric version, and space out word suffixes.
	const remainder = bare
		.slice(family.length)
		.replace(/([-.])([a-z0-9])/gi, (_all, sep: string, char: string) =>
			sep === "." ? `.${char.toUpperCase()}` : `${/[0-9]/.test(char) ? versionSeparator : " "}${char.toUpperCase()}`,
		);
	// Size suffixes read as capitals: "120b" -> "120B".
	const name = `${label}${remainder}`.replace(/([0-9])([a-z])/g, (_all, digit: string, char: string) => digit + char.toUpperCase());
	return org ? `${name} (${org})` : name;
}

/** True when the listing prices this model per token, i.e. it is a chat model. */
function hasTokenPricing(pricing: AsterLabPricing | undefined): boolean {
	if (!pricing) return false;
	return [
		pricing.input,
		pricing.output,
		pricing.input_per_million_tokens_usd,
		pricing.output_per_million_tokens_usd,
	].some((value) => typeof value === "number" && Number.isFinite(value));
}

function maxOutputFor(id: string, contextWindow: number): number {
	const bare = bareId(id);
	for (const override of MAX_OUTPUT_OVERRIDES) {
		if (override.pattern.test(bare)) return Math.min(contextWindow, override.maxTokens);
	}
	return Math.min(contextWindow, DEFAULT_MAX_TOKENS);
}

function reasoningByFamily(id: string): boolean {
	const bare = bareId(id);
	return REASONING_PATTERNS.some((pattern) => pattern.test(bare));
}

/**
 * Resolve the optional PI_ASTERLAB_CONTEXT_WINDOW ceiling. Returns undefined
 * when unset, non-numeric, or non-positive, so the advertised window stands.
 */
function contextWindowCeiling(env: Record<string, string | undefined> | undefined): number | undefined {
	const raw = env?.[CONTEXT_WINDOW_ENV_VAR]?.trim();
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		console.warn(
			`[asterlab] ignoring ${CONTEXT_WINDOW_ENV_VAR}=${raw}: expected a positive integer number of tokens.`,
		);
		return undefined;
	}
	return value;
}

/**
 * Context window for a listed model: AsterLab's advertised context_length,
 * optionally lowered by PI_ASTERLAB_CONTEXT_WINDOW. Never raised above what
 * AsterLab reports — the advertised 1048576 was verified servable end-to-end,
 * and inventing a larger number would let pi overflow the real limit.
 */
function contextWindowFor(m: AsterLabModel, ceiling: number | undefined): number {
	const advertised =
		typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : DEFAULT_CONTEXT_WINDOW;
	return ceiling === undefined ? advertised : Math.min(advertised, ceiling);
}

/**
 * Thinking levels for a reasoning model. AsterLab accepted every pi level
 * verbatim on glm-5.2, kimi-k3, and zai-org/glm-5.2-batch, and "none" zeroed out
 * reasoning_tokens, so "off" maps to "none" and no level is hidden.
 */
function fullThinkingLevelMap(): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off: "none" };
	for (const level of PI_LEVELS) {
		if (level === "off") continue;
		map[level] = level;
	}
	return map;
}

/**
 * Send one tiny chat request to confirm a listed model is actually callable and
 * to measure reasoning. AsterLab's listing leads real availability, so this is
 * what keeps unusable ids out of pi's picker.
 *
 * Only a 4xx refusal is treated as definitive. 429/5xx and transport failures
 * return "unknown" so a transient hiccup cannot silently empty the catalog.
 */
async function probeModel(id: string, apiKey: string, signal: AbortSignal): Promise<ProbeResult> {
	let response: Response;
	try {
		response = await fetch(ASTERLAB_CHAT_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: id,
				max_tokens: PROBE_MAX_TOKENS,
				messages: [{ role: "user", content: "ping" }],
			}),
			signal,
		});
	} catch (error) {
		return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
	}

	const text = await response.text().catch(() => "");

	if (!response.ok) {
		let detail = text.slice(0, 160).replaceAll("\n", " ").trim();
		try {
			const parsed = JSON.parse(text) as { error?: { message?: string } };
			if (parsed.error?.message) detail = parsed.error.message;
		} catch {
			// keep the raw body snippet
		}
		const reason = `HTTP ${response.status}${detail ? ` ${detail}` : ""}`;
		// 429 and 5xx are transient; anything else in the 4xx range is AsterLab
		// telling us this id cannot be used through chat completions.
		if (response.status === 429 || response.status >= 500) return { status: "unknown", reason };
		return { status: "rejected", reason };
	}

	let reasoning = false;
	try {
		const parsed = JSON.parse(text) as {
			choices?: { message?: { reasoning_content?: unknown } }[];
			usage?: { reasoning_tokens?: number };
		};
		reasoning =
			parsed.choices?.[0]?.message?.reasoning_content !== undefined || (parsed.usage?.reasoning_tokens ?? 0) > 0;
	} catch {
		// A 200 with an unparseable body still proves the model is callable.
	}
	return { status: "ok", reasoning };
}

/** Fetch AsterLab's public catalog, optionally verify each model, map to pi models. */
async function discoverAsterLabModels(signal?: AbortSignal): Promise<DiscoveredCatalog> {
	const response = await fetch(ASTERLAB_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`AsterLab /v1/models returned HTTP ${response.status} ${response.statusText}`);
	}
	const body = (await response.json()) as { data?: AsterLabModel[] } | AsterLabModel[];
	const listed = (Array.isArray(body) ? body : (body.data ?? [])).filter((m) => typeof m?.id === "string" && m.id);

	// Drop non-chat models before probing: no token pricing means AsterLab does
	// not serve them through /v1/chat/completions.
	const chatModels = listed.filter((m) => hasTokenPricing(m.pricing));
	const excluded: { id: string; reason: string }[] = listed
		.filter((m) => !hasTokenPricing(m.pricing))
		.map((m) => ({ id: m.id, reason: "no token pricing (not served via /v1/chat/completions)" }));

	// Verification needs a key; discovery does not. Skip silently when absent so
	// the provider still registers before /login.
	const env = typeof process === "undefined" ? undefined : process.env;
	const apiKey = env?.[API_KEY_ENV_VAR];
	const skipVerify = ["1", "true", "yes"].includes((env?.PI_ASTERLAB_SKIP_VERIFY ?? "").toLowerCase());
	const ceiling = contextWindowCeiling(env);

	const probes = new Map<string, ProbeResult>();
	if (apiKey && !skipVerify && chatModels.length > 0) {
		// Probes run concurrently, so one budget covers the whole pass.
		const probeSignal = signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS);
		const results = await Promise.all(
			chatModels.map(async (m) => [m.id, await probeModel(m.id, apiKey, probeSignal)] as const),
		);
		for (const [id, result] of results) probes.set(id, result);
	}
	const verified = probes.size > 0;

	const models: Model<Api>[] = [];
	for (const m of chatModels) {
		const probe = probes.get(m.id);
		if (probe?.status === "rejected") {
			excluded.push({ id: m.id, reason: probe.reason });
			continue;
		}
		// Measured when the probe succeeded; assumed from the family otherwise.
		const reasoning = probe?.status === "ok" ? probe.reasoning : reasoningByFamily(m.id);
		const pricing = m.pricing ?? {};
		// AsterLab reports both short and explicit per-million keys; they agree.
		const contextWindow = contextWindowFor(m, ceiling);

		const model = {
			id: m.id,
			name: displayName(m.id),
			api: "openai-completions" as const,
			provider: PROVIDER_ID,
			baseUrl: ASTERLAB_BASE_URL,
			reasoning,
			input: (VISION_PATTERN.test(bareId(m.id)) ? ["text", "image"] : ["text"]) as ("text" | "image")[],
			cost: {
				input: pricing.input_per_million_tokens_usd ?? pricing.input ?? 0,
				output: pricing.output_per_million_tokens_usd ?? pricing.output ?? 0,
				// Implicit prompt caching: verified via cached_tokens on a repeated
				// prompt, billed at cached_input_per_million_tokens_usd.
				cacheRead: pricing.cached_input_per_million_tokens_usd ?? 0,
				// AsterLab bills no separate cache-write rate.
				cacheWrite: 0,
			},
			contextWindow,
			maxTokens: maxOutputFor(m.id, contextWindow),
			...(reasoning ? { thinkingLevelMap: fullThinkingLevelMap() } : {}),
			compat: {
				// AsterLab proxies to Z.AI / Moonshot; both use "system".
				supportsDeveloperRole: false,
				// Accepted but ignored; keep it out of the payload.
				supportsStore: false,
				// What the upstreams use; AsterLab accepts both fields.
				maxTokensField: "max_tokens" as const,
				supportsReasoningEffort: reasoning,
				// Accepted but not honored as a schema guarantee by the upstreams.
				supportsStrictMode: false,
				// Verified: the final streamed chunk carries usage.
				supportsUsageInStreaming: true,
				// Caching is implicit; AsterLab exposes no retention control.
				supportsLongCacheRetention: false,
			},
		} as unknown as Model<Api>;

		models.push(model);
	}

	models.sort((a, b) => a.name.localeCompare(b.name));
	return { models, excluded, verified, ceiling };
}

/**
 * AsterLab's 4 MiB request-body cap, surfaced by pi as
 * `413: {"code":"413","message":"Request Entity Too Large"}`. None of pi's
 * overflow patterns match it (its `request_too_large` pattern expects
 * underscores), so pi cannot auto-compact without this rewrite.
 */
const PAYLOAD_TOO_LARGE_PATTERN = /FUNCTION_PAYLOAD_TOO_LARGE|Request Entity Too Large/i;

export default async function (pi: ExtensionAPI): Promise<void> {
	let catalog: DiscoveredCatalog = { models: [], excluded: [], verified: false };
	try {
		catalog = await discoverAsterLabModels();
		for (const entry of catalog.excluded) {
			console.warn(`[asterlab] excluded ${entry.id}: ${entry.reason}`);
		}
		if (catalog.ceiling !== undefined) {
			console.warn(
				`[asterlab] ${CONTEXT_WINDOW_ENV_VAR}=${catalog.ceiling}: context windows capped below AsterLab's advertised values.`,
			);
		}
		if (!catalog.verified) {
			console.warn(
				`[asterlab] models not verified against the live API (no $${API_KEY_ENV_VAR} at load time). ` +
					`AsterLab's listing can include ids that are not callable; run /reload after /login to re-check.`,
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`[asterlab] model discovery failed: ${message}. ` +
				`The provider is still available via \`/login asterlab\`; run /reload to retry discovery.`,
		);
	}

	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl: ASTERLAB_BASE_URL,
			// envApiKeyAuth gives `/login asterlab` (prompts + stores the key) AND
			// a $ASTERLAB_API_KEY env-var fallback. The resolved key is sent as
			// `Authorization: Bearer <key>` by the openai-completions API.
			auth: { apiKey: envApiKeyAuth("AsterLab API key", [API_KEY_ENV_VAR]) },
			api: openAICompletionsApi(),
			models: catalog.models,
		}),
	);

	// Rewrite AsterLab's payload-cap error into pi's generic overflow prefix so
	// pi drops the failed message, compacts, and retries once. Scoped to this
	// provider and to that exact phrase. The HTTP 400 `upstream_error` that the
	// same cap produces just above 4 MiB, and the 504 FUNCTION_INVOCATION_TIMEOUT
	// that very large prompts can hit, are deliberately NOT rewritten: the 400
	// body carries no detail distinguishing overflow from any other upstream
	// refusal, and the 504 is a transient serverless timeout. Rewriting either
	// would make pi compact on errors that belong to its normal retry path.
	// Lower PI_ASTERLAB_CONTEXT_WINDOW to stay clear of both.
	pi.on(
		"message_end",
		((
			event: { message: { role: string; stopReason?: string; provider?: string; errorMessage?: string } },
			ctx: { model?: { provider?: string } },
		) => {
			const message = event.message;
			if (message.role !== "assistant" || message.stopReason !== "error") return;
			if (message.provider !== PROVIDER_ID && ctx.model?.provider !== PROVIDER_ID) return;
			const errorMessage = message.errorMessage ?? "";
			if (errorMessage.includes("context_length_exceeded")) return;
			if (!PAYLOAD_TOO_LARGE_PATTERN.test(errorMessage)) return;
			return { message: { ...message, errorMessage: `context_length_exceeded: ${errorMessage}` } };
		}) as never,
	);
}
