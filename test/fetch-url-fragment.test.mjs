import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { extractContent } from "../extract.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const originalFetch = globalThis.fetch;
const indexUrl = new URL("../index.ts", import.meta.url).href;
const storageUrl = new URL("../storage.ts", import.meta.url).href;

// The target section sits far past the 30,000-character inline cut.
const pageHtml = (() => {
	const sections = [];
	for (let i = 1; i <= 60; i++) {
		sections.push(`<section id="section-${i}"><h2><a href="#section-${i}">${i}.</a> Topic ${i}</h2><p>${`Body text for topic ${i} with enough words to count as real content. `.repeat(12)}</p></section>`);
	}
	return `<!doctype html><html><head><title>Spec</title></head><body><main><h1>Spec</h1>${sections.join("\n")}</main></body></html>`;
})();

test("URL fragment records the offset of the target heading in extracted Markdown", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async () => new Response(pageHtml, { status: 200, headers: { "content-type": "text/html" } });

	const found = await extractContent("https://spec.example.com/doc.html#section-50", undefined, { lookup });
	assert.equal(found.error, null);
	assert.equal(found.fragment?.id, "section-50");
	assert.ok(found.fragment.offset > 30_000, String(found.fragment.offset));
	assert.match(found.content.slice(found.fragment.offset), /^## \[50\.\]\(#section-50\) Topic 50\n/);

	const missing = await extractContent("https://spec.example.com/doc.html#no-such-id", undefined, { lookup });
	assert.deepEqual(missing.fragment, { id: "no-such-id" });

	const plain = await extractContent("https://spec.example.com/doc.html", undefined, { lookup });
	assert.equal(plain.fragment, undefined);
});

async function runFetchTool(url) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-fragment-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			import { clearResults } from ${JSON.stringify(storageUrl)};
			clearResults();
			globalThis.fetch = async () => new Response(${JSON.stringify(pageHtml)}, { status: 200, headers: { "content-type": "text/html" } });
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			const fetchTool = tools.find(tool => tool.name === "fetch_content");
			const contentTool = tools.find(tool => tool.name === "get_search_content");
			const fetched = await fetchTool.execute("call", { url: ${JSON.stringify(url)} });
			const stored = await contentTool.execute("call", { responseId: fetched.details.responseId, urlIndex: 0, offset: 0, limit: 200 });
			console.log(JSON.stringify({ text: fetched.content.find(item => item.type === "text").text, totalChars: fetched.details.totalChars, storedStart: stored.content[0].text }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").pop());
}

test("fetch_content starts the inline preview at a found URL fragment and keeps the full page stored", async () => {
	const result = await runFetchTool("https://93.184.216.34/doc.html#section-50");
	assert.match(result.text, /^\[Starting at #section-50 \(offset \d+ of \d+\); full page stored\.\]\n\n## \[50\.\]\(#section-50\) Topic 50\n/);
	assert.match(result.text, /Topic 60/);
	assert.match(result.text, /offset: 0 \}\) for the page start\.$/);
	assert.match(result.storedStart, /## \[1\.\]\(#section-1\) Topic 1\n/);
	assert.ok(result.totalChars > 30_000);
});

test("fetch_content keeps the page start and says so when the URL fragment is not found", async () => {
	const result = await runFetchTool("https://93.184.216.34/doc.html#no-such-id");
	assert.match(result.text, /^\[#no-such-id not found in extracted text; showing the page start\.\]\n\n## \[1\.\]\(#section-1\) Topic 1\n/);
	assert.match(result.text, /for the next slice\.$/);
});
