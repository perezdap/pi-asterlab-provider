// Integration test: loads the real extension, runs the async factory (which
// fetches AsterLab's live /v1/models catalog and, when $ASTERLAB_API_KEY is set,
// verifies each model with a real 8-token chat request), then asserts the model
// mapping, the auth flow, and the message_end overflow rewrite.
//
// Run from the repository root: npm install && npm test
//
// Set PI_ASTERLAB_SKIP_VERIFY=1 to run the mapping assertions without spending
// probe requests (reasoning then falls back to the family table).

let pass = 0;
let fail = 0;
function assert(cond, msg) {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", msg);
	}
}
function assertEq(actual, expected, msg) {
	const ok = actual === expected;
	if (ok) pass++;
	else {
		fail++;
		console.error(`  FAIL: ${msg}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
	}
}

const mod = await import("../index.ts");
const factory = mod.default;
assert(typeof factory === "function", "default export is a function");

const registered = [];
const handlers = {};
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
const pi = {
	registerProvider(provider) {
		registered.push(provider);
	},
	on(event, handler) {
		(handlers[event] ??= []).push(handler);
	},
};

const hasKey = Boolean(process.env.ASTERLAB_API_KEY);
const skippingVerify = ["1", "true", "yes"].includes((process.env.PI_ASTERLAB_SKIP_VERIFY ?? "").toLowerCase());
const willProbe = hasKey && !skippingVerify;

await factory(pi);
console.warn = realWarn;

// ---- provider registration ----
assertEq(registered.length, 1, "exactly one provider registered");
const provider = registered[0];
assertEq(provider.id, "asterlab", "provider id is 'asterlab'");
assertEq(provider.name, "AsterLab", "provider name is 'AsterLab'");
assertEq(provider.baseUrl, "https://api.asterlab.ai/v1", "provider baseUrl");
assert(!!provider.auth?.apiKey, "provider has apiKey auth (for /login)");
assert(typeof provider.auth.apiKey.login === "function", "auth has login() for /login");
assert(typeof provider.auth.apiKey.resolve === "function", "auth has resolve()");
assert(typeof provider.streamSimple === "function", "provider exposes streamSimple (openai-completions)");

// ---- discovery ----
const models = provider.getModels();
assert(models.length > 0, `discovered models (count=${models.length})`);

const liveCatalog = await fetch("https://api.asterlab.ai/v1/models", {
	headers: { Accept: "application/json" },
}).then((response) => response.json());
const listed = liveCatalog.data ?? [];
const listedById = new Map(listed.map((model) => [model.id, model]));
assert(listed.length > 0, `live /v1/models listing is non-empty (count=${listed.length})`);

// Non-chat models (per_search_usd only, no token pricing) must never be offered.
const nonChat = listed.filter(
	(m) =>
		!(
			typeof m.pricing?.input === "number" ||
			typeof m.pricing?.output === "number" ||
			typeof m.pricing?.input_per_million_tokens_usd === "number" ||
			typeof m.pricing?.output_per_million_tokens_usd === "number"
		),
);
for (const m of nonChat) {
	assert(!models.some((mm) => mm.id === m.id), `non-chat model ${m.id} is omitted (no token pricing)`);
}

// Every registered id must exist in the live listing (no invented models).
for (const m of models) {
	assert(listedById.has(m.id), `model ${m.id} exists in the live listing`);
}

// When the probe ran, ids AsterLab definitively refuses are excluded and reported.
if (willProbe) {
	const excludedLines = warnings.filter((line) => line.includes("excluded"));
	for (const line of excludedLines) {
		const id = line.match(/excluded (\S+):/)?.[1];
		assert(!!id, `exclusion line names an id: ${line}`);
		assert(!models.some((m) => m.id === id), `excluded model ${id} is not registered`);
	}
	assert(
		warnings.some((line) => !line.includes("not verified")),
		"no 'not verified' warning when the probe ran",
	);
} else {
	assert(
		warnings.some((line) => line.includes("not verified against the live API")),
		"warns that models were not verified when no key/skip-verify",
	);
}

// ---- per-model mapping ----
for (const m of models) {
	assertEq(m.provider, "asterlab", `model ${m.id}: provider`);
	assertEq(m.api, "openai-completions", `model ${m.id}: api`);
	assertEq(m.baseUrl, "https://api.asterlab.ai/v1", `model ${m.id}: baseUrl`);
	assert(typeof m.name === "string" && m.name.length > 0, `model ${m.id}: has a display name`);
	assert(m.contextWindow > 0, `model ${m.id}: contextWindow > 0`);
	assert(m.maxTokens > 0, `model ${m.id}: maxTokens > 0`);
	assert(m.maxTokens <= m.contextWindow, `model ${m.id}: maxTokens <= contextWindow`);
	// The advertised 1M window is not servable; the clamp must hold for every model.
	assert(m.contextWindow <= 640_000, `model ${m.id}: contextWindow clamped to the servable ceiling`);
	assert(typeof m.cost.input === "number", `model ${m.id}: cost.input is number`);
	assert(typeof m.cost.output === "number", `model ${m.id}: cost.output is number`);
	assert(typeof m.cost.cacheRead === "number", `model ${m.id}: cost.cacheRead is number`);
	assertEq(m.cost.cacheWrite, 0, `model ${m.id}: cacheWrite is 0 (AsterLab bills no write rate)`);
	assert(Array.isArray(m.input) && m.input.includes("text"), `model ${m.id}: input includes text`);
	assert(typeof m.reasoning === "boolean", `model ${m.id}: reasoning is boolean`);

	// compat: what AsterLab's upstreams actually accept.
	assertEq(m.compat?.supportsDeveloperRole, false, `model ${m.id}: supportsDeveloperRole=false`);
	assertEq(m.compat?.supportsStore, false, `model ${m.id}: supportsStore=false`);
	assertEq(m.compat?.maxTokensField, "max_tokens", `model ${m.id}: maxTokensField=max_tokens`);
	assertEq(m.compat?.supportsStrictMode, false, `model ${m.id}: supportsStrictMode=false`);
	assertEq(m.compat?.supportsUsageInStreaming, true, `model ${m.id}: supportsUsageInStreaming=true`);
	assertEq(m.compat?.supportsLongCacheRetention, false, `model ${m.id}: supportsLongCacheRetention=false`);
	assertEq(m.compat?.cacheControlFormat, undefined, `model ${m.id}: no cache_control markers (implicit caching)`);
	assertEq(m.compat?.supportsReasoningEffort, m.reasoning, `model ${m.id}: effort advertised iff reasoning`);

	// Thinking levels: reasoning models expose every pi level, off -> "none".
	if (m.reasoning) {
		const map = m.thinkingLevelMap;
		assert(!!map, `model ${m.id}: reasoning model has thinkingLevelMap`);
		assertEq(map?.off, "none", `model ${m.id}: off -> "none"`);
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
			assertEq(map?.[level], level, `model ${m.id}: ${level} -> ${level}`);
		}
	} else {
		assertEq(m.thinkingLevelMap, undefined, `model ${m.id}: non-reasoning model has no thinkingLevelMap`);
	}

	// Pricing must match the live listing (per-million keys preferred).
	const live = listedById.get(m.id);
	if (live?.pricing) {
		const p = live.pricing;
		assertEq(m.cost.input, p.input_per_million_tokens_usd ?? p.input ?? 0, `model ${m.id}: cost.input from listing`);
		assertEq(m.cost.output, p.output_per_million_tokens_usd ?? p.output ?? 0, `model ${m.id}: cost.output from listing`);
		assertEq(
			m.cost.cacheRead,
			p.cached_input_per_million_tokens_usd ?? 0,
			`model ${m.id}: cost.cacheRead from cached_input rate`,
		);
	}
}

// Models are sorted by display name for a stable picker.
const names = models.map((m) => m.name);
assertEq(names.join("|"), [...names].sort((a, b) => a.localeCompare(b)).join("|"), "models sorted by name");

// ---- known-model sanity (only when present in the live catalog) ----
const glm = models.find((m) => m.id === "glm-5.2");
if (glm) {
	assertEq(glm.name, "GLM-5.2", "glm-5.2 display name");
	assertEq(glm.reasoning, true, "glm-5.2 is a reasoning model");
	// Listing advertises 1048576; the servable clamp wins.
	assertEq(glm.contextWindow, 640_000, "glm-5.2 contextWindow clamped from the advertised 1M");
	assertEq(glm.maxTokens, 131_072, "glm-5.2 maxTokens from the Z.AI family cap");
	assertEq(glm.cost.input, 1, "glm-5.2 cost.input = $1/M");
	assertEq(glm.cost.output, 4, "glm-5.2 cost.output = $4/M");
	assertEq(glm.cost.cacheRead, 0.2, "glm-5.2 cost.cacheRead = $0.20/M");
	assertEq(glm.input.includes("image"), false, "glm-5.2 is text-only (rejects image_url parts)");
}
const kimi = models.find((m) => m.id === "kimi-k3");
if (kimi) {
	assertEq(kimi.name, "Kimi K3", "kimi-k3 display name");
	assertEq(kimi.reasoning, true, "kimi-k3 is a reasoning model");
	assertEq(kimi.contextWindow, 640_000, "kimi-k3 contextWindow clamped from the advertised 1M");
	assertEq(kimi.maxTokens, 131_072, "kimi-k3 maxTokens from the Moonshot family cap");
	assertEq(kimi.input.includes("image"), true, "kimi-k3 accepts image input (verified live)");
	assert(kimi.cost.cacheRead > 0, "kimi-k3 exposes a cached-input rate");
}
const batch = models.find((m) => m.id === "zai-org/glm-5.2-batch");
if (batch) {
	assert(batch.name.includes("(zai-org)"), `batch model keeps its org prefix in the name (got ${batch.name})`);
	assertEq(batch.reasoning, true, "zai-org/glm-5.2-batch is a reasoning model");
}
// gpt-oss-120b is listed but AsterLab 404s every request shape for it; with the
// probe enabled it must be excluded, and the exclusion must be reported.
if (willProbe && listedById.has("gpt-oss-120b")) {
	assert(!models.some((m) => m.id === "gpt-oss-120b"), "gpt-oss-120b excluded (listed but not callable)");
	assert(
		warnings.some((line) => line.includes("excluded gpt-oss-120b")),
		"gpt-oss-120b exclusion is reported",
	);
}

// ---- message_end: payload-cap rewrite ----
const endHandlers = handlers.message_end ?? [];
assertEq(endHandlers.length, 1, "one message_end handler registered");
const hook = endHandlers[0];
function runHook(message, model) {
	return hook({ type: "message_end", message }, { model });
}

const asterlabModel = { provider: "asterlab", id: "glm-5.2" };
const payloadError = '413: {"code":"413","message":"Request Entity Too Large"}';

// The distinctive AsterLab body cap becomes pi's generic overflow prefix.
const rewritten = runHook(
	{ role: "assistant", stopReason: "error", provider: "asterlab", errorMessage: payloadError },
	asterlabModel,
);
assert(!!rewritten?.message, "payload-too-large error is rewritten");
assert(
	rewritten?.message?.errorMessage?.startsWith("context_length_exceeded:"),
	`rewritten message starts with context_length_exceeded (got ${rewritten?.message?.errorMessage})`,
);
assert(
	rewritten?.message?.errorMessage?.includes("Request Entity Too Large"),
	"rewritten message preserves the original detail",
);

// The FUNCTION_PAYLOAD_TOO_LARGE spelling is matched too.
const fnRewritten = runHook(
	{ role: "assistant", stopReason: "error", provider: "asterlab", errorMessage: "Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE" },
	asterlabModel,
);
assert(
	fnRewritten?.message?.errorMessage?.startsWith("context_length_exceeded:"),
	"FUNCTION_PAYLOAD_TOO_LARGE spelling is rewritten",
);

// Provider scoping: the current session model also identifies the provider.
const viaCtx = runHook(
	{ role: "assistant", stopReason: "error", errorMessage: payloadError },
	asterlabModel,
);
assert(!!viaCtx?.message, "rewrite applies when only ctx.model identifies the provider");

// Unrelated providers are untouched.
assertEq(
	runHook({ role: "assistant", stopReason: "error", provider: "openai", errorMessage: payloadError }, { provider: "openai", id: "gpt-5" }),
	undefined,
	"non-asterlab provider untouched",
);

// Idempotent: an already-rewritten message is left alone.
assertEq(
	runHook(
		{ role: "assistant", stopReason: "error", provider: "asterlab", errorMessage: `context_length_exceeded: ${payloadError}` },
		asterlabModel,
	),
	undefined,
	"already-rewritten message is not rewritten again",
);

// The serverless timeout is NOT an overflow: it must keep pi's normal retry path.
assertEq(
	runHook(
		{
			role: "assistant",
			stopReason: "error",
			provider: "asterlab",
			errorMessage: "504: An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT",
		},
		asterlabModel,
	),
	undefined,
	"FUNCTION_INVOCATION_TIMEOUT is not rewritten as overflow",
);

// Rate limits and upstream refusals are not overflows either.
for (const errorMessage of [
	'429: {"message":"Too many requests"}',
	'404: {"message":"The upstream model provider returned an error.","type":"invalid_request_error"}',
	'400: {"message":"The upstream model provider returned an error.","type":"upstream_error"}',
]) {
	assertEq(
		runHook({ role: "assistant", stopReason: "error", provider: "asterlab", errorMessage }, asterlabModel),
		undefined,
		`non-overflow error left alone: ${errorMessage.slice(0, 40)}`,
	);
}

// Non-error and non-assistant messages are ignored.
assertEq(
	runHook({ role: "assistant", stopReason: "stop", provider: "asterlab", errorMessage: payloadError }, asterlabModel),
	undefined,
	"successful message untouched",
);
assertEq(
	runHook({ role: "user", stopReason: "error", provider: "asterlab", errorMessage: payloadError }, asterlabModel),
	undefined,
	"non-assistant message untouched",
);

// ---- auth: /login flow + env fallback + stored credential ----
const auth = provider.auth.apiKey;
const mockInteraction = {
	signal: { throwIfAborted() {} },
	prompt: async () => "test-key-from-login",
};
const loginResult = await auth.login(mockInteraction);
assertEq(loginResult.type, "api_key", "login() returns an api_key credential");
assertEq(loginResult.key, "test-key-from-login", "login() returns the prompted key");

const resolveCtx = {
	env: async (name) => (name === "ASTERLAB_API_KEY" ? process.env.ASTERLAB_API_KEY : undefined),
};
const stored = await auth.resolve({
	ctx: resolveCtx,
	credential: { type: "api_key", key: "stored-key" },
	signal: { throwIfAborted() {} },
});
assertEq(stored.auth.apiKey, "stored-key", "resolve(): stored credential wins");
assertEq(stored.source, "stored credential", "resolve(): source is 'stored credential'");

if (process.env.ASTERLAB_API_KEY) {
	const envd = await auth.resolve({ ctx: resolveCtx, credential: undefined, signal: { throwIfAborted() {} } });
	assertEq(envd.auth.apiKey, process.env.ASTERLAB_API_KEY, "resolve(): falls back to ASTERLAB_API_KEY env");
	assertEq(envd.source, "ASTERLAB_API_KEY", "resolve(): source is the env var name");
}

const noneCtx = { env: async () => undefined };
const none = await auth.resolve({ ctx: noneCtx, credential: undefined, signal: { throwIfAborted() {} } });
assertEq(none, undefined, "resolve(): undefined when nothing configured");

console.log(`\nmodels: ${models.map((m) => m.id).join(", ")}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
