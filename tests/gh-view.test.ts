import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GhView, ghEntries, ghItemUrl, ghViewLayout, type GhViewDeps } from "../lib/gh-view.ts";
import type { GhSnapshot } from "../lib/gh-state.ts";
import type { GithubRepo, IssueSummary, PullRequestSummary } from "../lib/gh-client.ts";

// The overlay is the only surface that can open a pull request, so what it
// renders and which row a keystroke lands on has to be pinned by tests rather
// than by looking at it.

const REPO: GithubRepo = { host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" };

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function pull(number: number, title = `pull ${number}`, over: Partial<PullRequestSummary> = {}): PullRequestSummary {
	return {
		number,
		title,
		author: "doblas",
		isDraft: false,
		headRefName: `feat/${number}`,
		updatedAt: "2026-11-10T09:00:00Z",
		labels: [],
		commentCount: 0,
		reviewDecision: null,
		...over,
	};
}

function issue(number: number, title = `issue ${number}`, over: Partial<IssueSummary> = {}): IssueSummary {
	return { number, title, author: "someone", labels: [], commentCount: 0, updatedAt: "2026-11-10T09:00:00Z", ...over };
}

function snapshot(over: Partial<GhSnapshot> = {}): GhSnapshot {
	return { repo: REPO, pullRequests: [], issues: [], status: "ready", error: null, loadedAt: 1_000_000, version: 1, ...over };
}

interface Recorded {
	opened: string[];
	copied: string[];
	refreshed: number;
	closed: number;
	renders: number;
}

function viewOf(value: GhSnapshot | (() => GhSnapshot), rows = 20): { view: GhView; recorded: Recorded; set(snapshot: GhSnapshot): void } {
	let current = typeof value === "function" ? snapshot() : value;
	const recorded: Recorded = { opened: [], copied: [], refreshed: 0, closed: 0, renders: 0 };
	const deps: GhViewDeps = {
		theme: plainTheme,
		rows: () => rows,
		snapshot: () => current,
		openUrl: (url) => recorded.opened.push(url),
		copy: (text) => recorded.copied.push(text),
		refresh: () => {
			recorded.refreshed += 1;
		},
		close: () => {
			recorded.closed += 1;
		},
		requestRender: () => {
			recorded.renders += 1;
		},
	};
	return {
		view: new GhView(deps),
		recorded,
		set(next) {
			current = next;
		},
	};
}

const FULL = snapshot({
	pullRequests: [pull(2841, "docs: state that donations go through GitHub Sponsors"), pull(2839, "feat(gh): add the pane")],
	issues: [issue(2801, "[Bug]: accepting an invitation answers the previous company")],
});

test("the overlay lists pull requests before issues, as one flat selection", () => {
	const entries = ghEntries(FULL);
	assert.deepEqual(
		entries.map((entry) => `${entry.kind}#${entry.number}`),
		["pr#2841", "pr#2839", "issue#2801"],
	);
});

test("a wide terminal splits into a list and a detail pane", () => {
	const layout = ghViewLayout(140);
	assert.equal(layout.mode, "split");
	assert.ok(layout.listWidth >= 24 && layout.listWidth <= 44, `list width ${layout.listWidth}`);
	assert.equal(layout.listWidth + layout.detailWidth + 1, 140, "one column between the panes");
});

test("a narrow terminal shows the list alone instead of two unreadable columns", () => {
	const layout = ghViewLayout(50);
	assert.equal(layout.mode, "list");
	assert.equal(layout.detailWidth, 0);
});

test("the header names the repository and both counts", () => {
	const { view } = viewOf(FULL);
	const text = view.render(120).join("\n");
	assert.match(text, /Gentleman-Programming\/gentle-shell/);
	assert.match(text, /2 pull requests/i);
	assert.match(text, /1 issue/i);
});

test("the list carries group headers and every item", () => {
	const { view } = viewOf(FULL);
	const text = view.render(120).join("\n");
	assert.match(text, /#2841/);
	assert.match(text, /#2839/);
	assert.match(text, /#2801/);
});

test("j and k move the selection and clamp at both ends", () => {
	const { view } = viewOf(FULL);
	assert.equal(view.selected()?.number, 2841);
	view.handleInput("j");
	assert.equal(view.selected()?.number, 2839);
	view.handleInput("k");
	view.handleInput("k");
	assert.equal(view.selected()?.number, 2841, "the first row is the top");
	for (let index = 0; index < 9; index += 1) view.handleInput("j");
	assert.equal(view.selected()?.number, 2801, "the last row is the bottom");
});

test("the detail pane describes the selected item and follows the selection", () => {
	const { view } = viewOf(FULL);
	const first = view.render(120).join("\n");
	assert.match(first, /doblas/);
	assert.match(first, /feat\/2841/);
	view.handleInput("j");
	view.handleInput("j");
	const third = view.render(120).join("\n");
	assert.match(third, /someone/);
});

test("enter opens the selected pull request on github, and an issue under its own path", () => {
	const { view, recorded } = viewOf(FULL);
	view.handleInput("\r");
	assert.deepEqual(recorded.opened, ["https://github.com/Gentleman-Programming/gentle-shell/pull/2841"]);
	view.handleInput("j");
	view.handleInput("j");
	view.handleInput("\r");
	assert.equal(recorded.opened[1], "https://github.com/Gentleman-Programming/gentle-shell/issues/2801");
});

test("o opens as well, and y copies the number a person would paste", () => {
	const { view, recorded } = viewOf(FULL);
	view.handleInput("o");
	assert.equal(recorded.opened.length, 1);
	view.handleInput("y");
	assert.deepEqual(recorded.copied, ["#2841"]);
});

test("r asks for a refresh, q and escape close", () => {
	const { view, recorded } = viewOf(FULL);
	view.handleInput("r");
	assert.equal(recorded.refreshed, 1);
	view.handleInput("q");
	view.handleInput("\u001b");
	assert.equal(recorded.closed, 2);
});

test("an empty repository says so, loading says loading, and a failure explains itself", () => {
	assert.match(viewOf(snapshot()).view.render(120).join("\n"), /none open/i);
	const loading = viewOf(snapshot({ status: "loading", loadedAt: null })).view.render(120).join("\n");
	assert.match(loading, /loading/i);
	assert.doesNotMatch(loading, /none open/i);
	assert.match(viewOf(snapshot({ status: "error", error: "gh: not authenticated" })).view.render(120).join("\n"), /not authenticated/);
});

test("the view fills its height exactly and never paints a row wider than the terminal", () => {
	const { view } = viewOf(FULL, 12);
	for (const width of [50, 80, 120]) {
		const lines = view.render(width);
		assert.equal(lines.length, 12, `height at ${width}`);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `over-wide row at ${width}: ${JSON.stringify(line)}`);
	}
});

test("the footer lists the keys the view actually handles", () => {
	const { view } = viewOf(FULL);
	const footer = view.render(120).at(-1)!;
	for (const hint of ["enter", "o", "y", "r", "esc"]) assert.match(footer, new RegExp(hint), `footer should mention ${hint}`);
});

test("a selection past a shrinking list lands on a real row", () => {
	const { view, set } = viewOf(FULL);
	view.handleInput("j");
	view.handleInput("j");
	assert.equal(view.selected()?.number, 2801);
	set(snapshot({ pullRequests: [pull(1)], issues: [] }));
	assert.equal(view.selected()?.number, 1, "the selection is clamped to what is still there");
});

test("the item url is a pull request or an issue, never the wrong one", () => {
	assert.equal(ghItemUrl(REPO, { kind: "pr", number: 7 }), "https://github.com/Gentleman-Programming/gentle-shell/pull/7");
	assert.equal(ghItemUrl(REPO, { kind: "issue", number: 7 }), "https://github.com/Gentleman-Programming/gentle-shell/issues/7");
});

test("with no pull requests and no issues the selection is empty and enter does nothing", () => {
	const { view, recorded } = viewOf(snapshot());
	assert.equal(view.selected(), undefined);
	view.handleInput("\r");
	assert.deepEqual(recorded.opened, []);
});
