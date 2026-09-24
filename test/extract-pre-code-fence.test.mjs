import assert from "node:assert/strict";
import { test } from "node:test";

import { extractContent } from "../extract.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const originalFetch = globalThis.fetch;
const filler = "<p>" + "Coroutines declared with the async/await syntax are the preferred way of writing asyncio applications. ".repeat(4) + "</p>";

test("readable fetch fences <pre> without <code> verbatim and keeps <pre><code> output", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	// Sphinx (docs.python.org) markup: highlighted <pre><span> with no <code> child.
	const html = `<!doctype html><html><head><title>Coroutines and Tasks</title></head><body><div class="body" role="main"><section id="tasks">
<h1>Coroutines and Tasks</h1>${filler}${filler}
<div class="highlight-python3 notranslate"><div class="highlight"><pre><span></span><span class="k">async</span> <span class="k">def</span> <span class="nf">main</span><span class="p">():</span>
    <span class="c1"># comment here</span>
    <span class="n">task</span> <span class="o">=</span> <span class="n">asyncio</span><span class="o">.</span><span class="n">create_task</span><span class="p">(</span><span class="n">coro</span><span class="p">())</span>
</pre></div></div>
${filler}
<pre><code class="language-js">const a_b = 1; // x
</code></pre>
${filler}</section></div></body></html>`;
	globalThis.fetch = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });

	const result = await extractContent("https://docs.example.com/asyncio-task.html", undefined, { lookup });
	assert.equal(result.error, null);
	assert.ok(
		result.content.includes("```\nasync def main():\n    # comment here\n    task = asyncio.create_task(coro())\n```"),
		result.content,
	);
	assert.ok(!result.content.includes("create\\_task"));
	assert.ok(!result.content.includes("\\#"));
	// Existing <pre><code> handling is unchanged.
	assert.ok(result.content.includes("```\nconst a_b = 1; // x\n```"), result.content);
});
