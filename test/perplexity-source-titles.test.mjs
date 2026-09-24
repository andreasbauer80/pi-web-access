import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;

test("Perplexity labels sources with search_results titles and falls back to Source N", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-perplexity-titles-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async () => new Response(JSON.stringify({
				choices: [{ message: { content: "TaskGroup was added in Python 3.11 [1][2]." } }],
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
