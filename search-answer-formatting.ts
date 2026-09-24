interface AnswerResult {
	title: string;
	url: string;
	snippet: string;
}

export function formatSearchResultsAsAnswer(results: readonly AnswerResult[]): string {
	return results.map((result) => result.snippet
		? `${result.snippet}\nSource: ${result.title} (${result.url})`
		: `Source: ${result.title} (${result.url})`).join("\n\n");
}

// Chat-style closers such as "If you want, I can also ..." add nothing to a search answer.
const TRAILING_OFFER = /^(?:if you(?:'d| would)? (?:want|like),|if you(?:'d| would)? (?:want|like) me to\b|would you like\b|let me know\b)/i;

/** Remove a final paragraph only when it is clearly a chat offer; keep single-paragraph answers. */
export function stripTrailingOffer(answer: string): string {
	const trimmed = answer.trimEnd();
	const breakAt = trimmed.search(/\n\s*\n(?![\s\S]*\n\s*\n)/);
	if (breakAt < 0) return answer;
	const last = trimmed.slice(breakAt).trim();
	return TRAILING_OFFER.test(last) ? trimmed.slice(0, breakAt).trimEnd() : answer;
}
