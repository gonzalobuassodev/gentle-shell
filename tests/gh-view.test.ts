import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GhView, ghEntries, ghItemUrl, ghViewLayout, type GhEntryKind, type GhViewDeps, type GhViewTheme } from "../lib/gh-view.ts";
import type { GhSnapshot } from "../lib/gh-state.ts";
import { nextIssueState, nextPrState, type GithubRepo, type IssueSummary, type PullRequestSummary } from "../lib/gh-client.ts";

// The overlay is the only surface that can open a pull request, so what it
// renders and which row a keystroke lands on has to be pinned by tests rather
// than by looking at it. It now shows one tab at a time, which makes "which tab
// is on screen" and "where the selection sits in it" the two things a keystroke
// can get wrong.

const REPO: GithubRepo = { host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" };

const plainTheme: GhViewTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// Roles survive in the text, so an assertion can name which tab is being painted
// as active instead of trusting a colour the test cannot see.
const taggedTheme: GhViewTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
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
	return { repo: REPO, prState: "open", issueState: "open", pullRequests: [], issues: [], status: "ready", error: null, loadedAt: 1_000_000, version: 1, ...over };
}

interface Recorded {
	opened: string[];
	copied: string[];
	refreshed: number;
	closed: number;
	renders: number;
	cycles: GhEntryKind[];
}

function viewOf(value: GhSnapshot, rows = 20, theme: GhViewTheme = plainTheme): { view: GhView; recorded: Recorded; set(next: GhSnapshot): void } {
	let current = value;
	const recorded: Recorded = { opened: [], copied: [], refreshed: 0, closed: 0, renders: 0, cycles: [] };
	const deps: GhViewDeps = {
		theme,
		rows: () => rows,
		snapshot: () => current,
		openUrl: (url) => recorded.opened.push(url),
		copy: (text) => recorded.copied.push(text),
		refresh: () => {
			recorded.refreshed += 1;
		},
		// The store answers a cycle with the new state and that tab's rows; this
		// stand-in only has to move the state the view reads back.
		cycleState: (kind) => {
			recorded.cycles.push(kind);
			current = kind === "pr" ? { ...current, prState: nextPrState(current.prState) } : { ...current, issueState: nextIssueState(current.issueState) };
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
	issues: [issue(2801, "[Bug]: accepting an invitation answers the previous company"), issue(2790, "[Feature]: tabs")],
});

test("each tab lists its own kind, and only its own kind", () => {
	assert.deepEqual(
		ghEntries(FULL, "pr").map((entry) => `${entry.kind}#${entry.number}`),
		["pr#2841", "pr#2839"],
	);
	assert.deepEqual(
		ghEntries(FULL, "issue").map((entry) => `${entry.kind}#${entry.number}`),
		["issue#2801", "issue#2790"],
	);
});

test("the tab row carries both labels and their counts, active first", () => {
	const { view } = viewOf(FULL, 20, taggedTheme);
	const tabs = view.render(120)[1]!;
	assert.match(tabs, /<accent>Pull requests 2<\/accent>/, "the active tab is painted with the accent role");
	assert.match(tabs, /<dim>Issues 2<\/dim>/, "the inactive tab is dim");
	assert.match(tabs, /<accent>Pull requests 2<\/accent> │ <dim>Issues 2<\/dim>/, "one row, both tabs, separated by a rule");
});

test("both tabs stay visible even when the active one has nothing in it", () => {
	const { view } = viewOf(snapshot(), 20, taggedTheme);
	const tabs = view.render(120)[1]!;
	assert.match(tabs, /<accent>Pull requests 0<\/accent>/);
	assert.match(tabs, /<dim>Issues 0<\/dim>/);
});

test("the list shows only the active tab", () => {
	const { view } = viewOf(FULL);
	const pullTab = view.render(120).join("\n");
	assert.match(pullTab, /#2841/);
	assert.doesNotMatch(pullTab, /#2801/, "the issue rows belong to the other tab");

	view.handleInput("\t");
	const issueTab = view.render(120).join("\n");
	assert.match(issueTab, /#2801/);
	assert.doesNotMatch(issueTab, /#2841/, "the pull request rows left with the tab");
});

test("tab and l move to the next tab, shift+tab and h to the previous one, wrapping", () => {
	const { view } = viewOf(FULL);
	assert.equal(view.selected()?.kind, "pr", "the pane opens on pull requests");
	view.handleInput("\t");
	assert.equal(view.selected()?.kind, "issue");
	assert.equal(view.selected()?.number, 2801, "the new tab starts on its own first row");
	view.handleInput("l");
	assert.equal(view.selected()?.kind, "pr", "the tabs wrap around");
	view.handleInput("\u001b[Z");
	assert.equal(view.selected()?.kind, "issue", "shift+tab walks back");
	view.handleInput("\u001b[Z");
	view.handleInput("h");
	assert.equal(view.selected()?.kind, "issue");
});

test("the selection is remembered per tab", () => {
	const { view } = viewOf(FULL);
	view.handleInput("j");
	assert.equal(view.selected()?.number, 2839, "second pull request");
	view.handleInput("\t");
	assert.equal(view.selected()?.number, 2801, "the issue tab has its own first row");
	view.handleInput("j");
	assert.equal(view.selected()?.number, 2790);
	view.handleInput("\t");
	assert.equal(view.selected()?.number, 2839, "the pull request tab kept the row it was on");
	view.handleInput("\u001b[Z");
	assert.equal(view.selected()?.number, 2790, "and so did the issue tab");
});

test("j, k and the arrows move inside the active tab only", () => {
	const { view } = viewOf(FULL);
	view.handleInput("j");
	view.handleInput("\u001b[B");
	assert.equal(view.selected()?.number, 2839);
	view.handleInput("j");
	assert.equal(view.selected()?.number, 2839, "the bottom of the pull request list is not the issue tab's first row");
	view.handleInput("k");
	assert.equal(view.selected()?.number, 2841);
	view.handleInput("\u001b[A");
	assert.equal(view.selected()?.number, 2841, "the top row is the top");
	view.handleInput("\t");
	assert.equal(view.selected()?.number, 2801, "the issue tab never moved");
});

test("the detail pane follows the active tab's selection", () => {
	const { view } = viewOf(FULL);
	const first = view.render(120).join("\n");
	assert.match(first, /doblas/);
	assert.match(first, /feat\/2841/);
	view.handleInput("\t");
	const issues = view.render(120).join("\n");
	assert.match(issues, /someone/);
	assert.doesNotMatch(issues, /feat\/2841/);
});

test("the header names the tab on screen and that tab's state", () => {
	const { view } = viewOf(snapshot({ prState: "merged", issueState: "closed" }));
	assert.match(view.render(120)[0]!, /Gentleman-Programming\/gentle-shell/);
	assert.match(view.render(120)[0]!, /pull requests merged/);
	view.handleInput("\t");
	assert.match(view.render(120)[0]!, /issues closed/, "the header follows the tab");
	assert.doesNotMatch(view.render(120)[0]!, /merged/);
});

test("enter, space, o and y act on the active tab's selection", () => {
	const { view, recorded } = viewOf(FULL);
	view.handleInput("\r");
	assert.deepEqual(recorded.opened, ["https://github.com/Gentleman-Programming/gentle-shell/pull/2841"]);
	view.handleInput("y");
	assert.deepEqual(recorded.copied, ["#2841"]);
	view.handleInput("\t");
	view.handleInput("o");
	assert.equal(recorded.opened[1], "https://github.com/Gentleman-Programming/gentle-shell/issues/2801");
	view.handleInput(" ");
	assert.equal(recorded.opened.length, 3);
	view.handleInput("y");
	assert.deepEqual(recorded.copied, ["#2841", "#2801"]);
});

test("r asks for a refresh, q and escape close", () => {
	const { view, recorded } = viewOf(FULL);
	view.handleInput("r");
	assert.equal(recorded.refreshed, 1);
	view.handleInput("q");
	view.handleInput("\u001b");
	assert.equal(recorded.closed, 2);
});

test("s cycles the active tab's state and leaves the other tab alone", () => {
	const { view, recorded } = viewOf(FULL);
	view.handleInput("s");
	view.handleInput("s");
	assert.deepEqual(recorded.cycles, ["pr", "pr"], "the pull request tab is the one on screen");
	assert.equal(recorded.renders, 2, "a keystroke the store has not answered yet still repaints");
	view.handleInput("\t");
	view.handleInput("s");
	assert.deepEqual(recorded.cycles, ["pr", "pr", "issue"]);
});

test("a full page of rows counts as 30+, an exact count stays exact", () => {
	const capped = snapshot({
		pullRequests: Array.from({ length: 30 }, (_, index) => pull(index + 1)),
		issues: Array.from({ length: 29 }, (_, index) => issue(index + 1)),
	});
	const tabs = viewOf(capped).view.render(120)[1]!;
	assert.match(tabs, /Pull requests 30\+/, "a capped list may be the head of a much longer one");
	assert.match(tabs, /Issues 29/, "one row short of the cap is an exact number");
	assert.doesNotMatch(tabs, /Issues 30/);
});

test("the empty body names the active tab and its state, not some other tab's", () => {
	assert.match(viewOf(snapshot()).view.render(120).join("\n"), /no pull requests open/i);

	const issuesClosed = viewOf(snapshot({ issueState: "closed" }));
	issuesClosed.view.handleInput("\t");
	assert.match(issuesClosed.view.render(120).join("\n"), /no issues closed/i);

	const prMerged = viewOf(snapshot({ prState: "merged", issueState: "open" }));
	assert.match(prMerged.view.render(120).join("\n"), /no pull requests merged/i);
	assert.doesNotMatch(prMerged.view.render(120).join("\n"), /no issues/i, "the other tab is not on screen");

	const all = viewOf(snapshot({ prState: "all" }));
	assert.match(all.view.render(120).join("\n"), /no pull requests at all/i);
});

test("an empty repository says so, loading says loading, and a failure explains itself", () => {
	const loading = viewOf(snapshot({ status: "loading", loadedAt: null })).view.render(120).join("\n");
	assert.match(loading, /loading/i);
	assert.doesNotMatch(loading, /none open/i);
	assert.match(viewOf(snapshot({ status: "error", error: "gh: not authenticated" })).view.render(120).join("\n"), /not authenticated/);
});

test("the footer lists the keys the view actually handles, and fits the narrowest split", () => {
	const { view } = viewOf(FULL);
	const footer = view.render(120).at(-1)!;
	for (const hint of ["esc", "tab/shift+tab", "j/k", "enter", "o", "y", "r", "s state"]) assert.ok(footer.includes(hint), `footer should mention ${hint}`);
	// Nothing may be clipped away: at eighty columns the last hint still has its label.
	assert.match(view.render(80).at(-1)!, /s state/);
});

test("the view fills its height exactly and never paints a row wider than the terminal", () => {
	for (const lines of [8, 12, 24]) {
		const { view } = viewOf(FULL, lines);
		for (const width of [20, 50, 80, 120]) {
			const rendered = view.render(width);
			assert.equal(rendered.length, Math.max(4, lines), `height at ${width}x${lines}`);
			for (const line of rendered) assert.ok(visibleWidth(line) <= width, `over-wide row at ${width}: ${JSON.stringify(line)}`);
		}
	}
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

test("a selection past a shrinking list lands on a real row", () => {
	const { view, set } = viewOf(FULL);
	view.handleInput("\t");
	view.handleInput("j");
	assert.equal(view.selected()?.number, 2790);
	set(snapshot({ pullRequests: [pull(1)], issues: [issue(2)] }));
	assert.equal(view.selected()?.number, 2, "the selection is clamped to what is still there");
	view.handleInput("\t");
	assert.equal(view.selected()?.number, 1);
});

test("the item url is a pull request or an issue, never the wrong one", () => {
	assert.equal(ghItemUrl(REPO, { kind: "pr", number: 7 }), "https://github.com/Gentleman-Programming/gentle-shell/pull/7");
	assert.equal(ghItemUrl(REPO, { kind: "issue", number: 7 }), "https://github.com/Gentleman-Programming/gentle-shell/issues/7");
});

test("with no rows on the active tab the selection is empty and enter does nothing", () => {
	const { view, recorded } = viewOf(snapshot({ issues: [issue(2801)] }));
	assert.equal(view.selected(), undefined);
	view.handleInput("\r");
	assert.deepEqual(recorded.opened, []);
	view.handleInput("\t");
	assert.equal(view.selected()?.number, 2801, "the other tab still has its row");
});
