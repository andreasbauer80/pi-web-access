import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

// All sessions in one Pi process share this extension module. These tests
// create two extension instances (two sessions) on the same module state.
const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const testAgentDir = mkdtempSync(join(tmpdir(), "pi-web-access-session-scope-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.env.OPENAI_API_KEY = "session-scope-test-key";
writeFileSync(join(testAgentDir, "web-search.json"), JSON.stringify({ provider: "openai" }));

const { default: initializeExtension } = await import("../index.ts");
const { clearResults, getFetchCacheDir } = await import("../storage.ts");

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearResults();
	rmSync(getFetchCacheDir(), { recursive: true, force: true });
});

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalOpenAIKey;
	rmSync(testAgentDir, { recursive: true, force: true });
});

function createSession(sessionId) {
	const tools = [];
	const handlers = new Map();
	const branch = [];
	const messages = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on(event, handler) { handlers.set(event, handler); },
		appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
		sendMessage(message) { messages.push(message); },
	});
	const ctx = { sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
	const tool = (name) => tools.find((candidate) => candidate.name === name);
	return {
		branch,
		messages,
		start: () => handlers.get("session_start")({ type: "session_start" }, ctx),
		tree: () => handlers.get("session_tree")({ type: "session_tree" }, ctx),
		shutdown: () => handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx),
		async search(query, extra = {}) {
			const result = await tool("web_search").execute("search", { query, provider: "openai", workflow: "none", ...extra });
			return result.details;
		},
		fetch: (url) => tool("fetch_content").execute("fetch", { url }),
		read: (params) => tool("get_search_content").execute("read", params),
	};
}

// OpenAI search returns one source per query; the source URL is the query text.
function mockSearch(pageFetch) {
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url === "https://api.openai.com/v1/responses") {
			const body = JSON.parse(init.body);
			const query = JSON.stringify(body).match(/https:\/\/93\.184\.216\.34\/[a-z-]+/)?.[0] ?? "https://93.184.216.34/source";
			return new Response(JSON.stringify({ output: [
				{ type: "web_search_call", action: { sources: [{ title: "Source", url: query }] } },
				{ type: "message", content: [{ type: "output_text", text: `Answer for ${query}` }] },
			] }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return pageFetch(url, init);
	};
}

test("another session's start and shutdown keep this session's responseIds readable", async () => {
	mockSearch(async () => { throw new Error("unexpected page fetch"); });
	const a = createSession("session-a");
	await a.start();
	const { searchId } = await a.search("https://93.184.216.34/alpha");
	assert.ok(searchId);
	assert.equal((await a.read({ responseId: searchId, queryIndex: 0 })).details.error, undefined);

	const b = createSession("session-b");
	await b.start();
	const afterStart = await a.read({ responseId: searchId, queryIndex: 0 });
	assert.equal(afterStart.details.error, undefined, afterStart.content[0].text);

	await b.shutdown();
	const afterShutdown = await a.read({ responseId: searchId, queryIndex: 0 });
	assert.equal(afterShutdown.details.error, undefined, afterShutdown.content[0].text);
	assert.match(afterShutdown.content[0].text, /93\.184\.216\.34\/alpha/);

	await a.shutdown();
	const afterOwnShutdown = await a.read({ responseId: searchId, queryIndex: 0 });
	assert.equal(afterOwnShutdown.details.error, "Not found");
	assert.match(afterOwnShutdown.content[0].text, /is no longer in memory \(for example after a session reload or restart\)/);
	assert.match(afterOwnShutdown.content[0].text, /again to get a new responseId/);
});

test("session_tree restores only the navigating session's branch", async () => {
	mockSearch(async () => { throw new Error("unexpected page fetch"); });
	const a = createSession("session-a");
	const b = createSession("session-b");
	await a.start();
	await b.start();
	const { searchId: aId } = await a.search("https://93.184.216.34/alpha");
	const { searchId: bId } = await b.search("https://93.184.216.34/beta");

	// A navigates to a branch without its search entry.
	const saved = a.branch.splice(0);
	await a.tree();
	assert.equal((await a.read({ responseId: aId, queryIndex: 0 })).details.error, "Not found");
	assert.equal((await a.read({ responseId: bId, queryIndex: 0 })).details.error, undefined);

	// A navigates back; its entry is restored from the branch.
	a.branch.push(...saved);
	await a.tree();
	assert.equal((await a.read({ responseId: aId, queryIndex: 0 })).details.error, undefined);
	assert.equal((await b.read({ responseId: bId, queryIndex: 0 })).details.error, undefined);
});

test("session shutdown aborts only that session's background fetches", async () => {
	const signals = new Map();
	let releaseAlpha;
	mockSearch((url, init) => {
		signals.set(url, init?.signal);
		if (url.endsWith("/alpha")) {
			return new Promise((resolve) => { releaseAlpha = () => resolve(new Response("alpha page", { status: 200, headers: { "content-type": "text/plain" } })); });
		}
		return new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
		});
	});
	const a = createSession("session-a");
	const b = createSession("session-b");
	await a.start();
	await b.start();
	const aSearch = await a.search("https://93.184.216.34/alpha", { includeContent: true });
	const bSearch = await b.search("https://93.184.216.34/beta", { includeContent: true });
	assert.ok(aSearch.fetchId);
	assert.ok(bSearch.fetchId);
	for (let i = 0; i < 200 && (!signals.has("https://93.184.216.34/alpha") || !signals.has("https://93.184.216.34/beta") || !releaseAlpha); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(signals.get("https://93.184.216.34/beta"), "session B fetch did not start");
	assert.ok(signals.get("https://93.184.216.34/alpha"), "session A fetch did not start");

	await b.shutdown();
	assert.equal(signals.get("https://93.184.216.34/beta").aborted, true);
	assert.equal(signals.get("https://93.184.216.34/alpha").aborted, false);

	releaseAlpha();
	for (let i = 0; i < 200 && a.messages.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(a.messages.length, 1);
	assert.match(a.messages[0].content, new RegExp(`Content fetched for 1/1 URLs \\[${aSearch.fetchId}\\]`));
	assert.equal(b.messages.length, 0);
	const alpha = await a.read({ responseId: aSearch.fetchId });
	assert.match(alpha.content[0].text, /alpha page/);
});

test("a fetch result missing from memory is rebuilt from the on-disk cache", async () => {
	globalThis.fetch = async () => new Response("cached page body", { status: 200, headers: { "content-type": "text/plain" } });
	const a = createSession("session-a");
	await a.start();
	const fetched = await a.fetch("https://93.184.216.34/cached");
	const responseId = fetched.details.responseId;
	assert.ok(responseId);

	await a.shutdown();
	const rebuilt = await a.read({ responseId });
	assert.equal(rebuilt.details.error, undefined, rebuilt.content[0].text);
	assert.match(rebuilt.content[0].text, /cached page body/);

	rmSync(getFetchCacheDir(), { recursive: true, force: true });
	const gone = await a.read({ responseId });
	assert.equal(gone.details.error, "Not found");
});
