import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { stripTrailingOffer } from "../search-answer-formatting.ts";

const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;

test("stripTrailingOffer removes a final chat offer paragraph", () => {
	const body = "asyncio.TaskGroup was added in Python 3.11 [1].\n\nIt replaces most uses of gather() [2].";
	for (const offer of [
		"If you want, I can also give you a side-by-side example.",
		"If you'd like, I can compare it with trio nurseries.",
		"If you would like me to, I can write a migration guide.",
		"Would you like a code sample?",
		"Let me know if you need more detail.",
	]) {
		assert.equal(stripTrailingOffer(`${body}\n\n${offer}\n`), body, offer);
	}
});

test("stripTrailingOffer keeps a normal last paragraph and single-paragraph answers", () => {
	const normal = "TaskGroup was added in 3.11.\n\nIf you want to cancel all tasks, raise an exception inside the group.";
	assert.equal(stripTrailingOffer(normal), normal);
	const plain = "TaskGroup was added in 3.11.\n\nSee the asyncio docs for details.";
	assert.equal(stripTrailingOffer(plain), plain);
	const single = "Let me know is a common phrase.";
	assert.equal(stripTrailingOffer(single), single);
});

test("Perplexity strips trailing chat offers and labels sources with search_results titles", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-perplexity-titles-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async () => new Response(JSON.stringify({
				choices: [{ message: { content: "TaskGroup was added in Python 3.11 [1][2].\\n\\nIf you want, I can also give you an example." } }],
				citations: ["https://docs.python.org/3/whatsnew/3.11.html", "https://example.com/untitled"],
				search_results: [{ title: "What's New In Python 3.11", url: "https://docs.python.org/3/whatsnew/3.11.html", date: "2022-10-24" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
			const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModuleUrl)});
			const response = await searchWithPerplexity("taskgroup", { numResults: 2 });
			console.log(JSON.stringify(response));
		`,
		encoding: "utf8",
		env: { ...process.env, HOME: home, USERPROFILE: home, PERPLEXITY_API_KEY: "pplx-test-key", PI_CODING_AGENT_DIR: undefined, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	const response = JSON.parse(child.stdout.trim().split("\n").pop());
	assert.equal(response.answer, "TaskGroup was added in Python 3.11 [1][2].");
	assert.deepEqual(response.results.map((item) => item.title), ["What's New In Python 3.11", "Source 2"]);
});
