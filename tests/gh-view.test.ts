import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BODY_MAX_BYTES, BODY_MAX_LINES, BODY_TRUNCATED, GhView, PANE_SEPARATOR, ghBodyLines, ghEntries, ghItemUrl, ghViewLayout, type GhEntryKind, type GhViewDeps, type GhViewTheme } from "../lib/gh-view.ts";
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
		body: "",
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
	return { number, title, author: "someone", body: "", labels: [], commentCount: 0, updatedAt: "2026-11-10T09:00:00Z", ...over };
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

// The detail column of every body row: the description is the only thing in the
// pane that can be taller than the pane, so most of what a keystroke does is
// read here, and the list side is deliberately ignored.
function detailRows(rendered: string[]): string[] {
	return rendered.slice(2, -1).map((row) => {
		const at = row.indexOf(PANE_SEPARATOR);
		return at < 0 ? "" : row.slice(at + PANE_SEPARATOR.length).trimEnd();
	});
}

// Long enough to need scrolling at every height a test renders: a paragraph, a
// blank line, an unbreakable token and more rows than any pane can hold.
const LONG_BODY = [
	"The pane has to hold a description that is taller than the pane itself,",
	"",
	`an unbreakable token: ${"x".repeat(200)}`,
	"",
	...Array.from({ length: 40 }, (_, index) => `row ${index + 1}`),
].join("\n");

function longSnapshot(): GhSnapshot {
	return snapshot({
		pullRequests: [pull(2841, "docs: state that donations go through GitHub Sponsors", { body: LONG_BODY }), pull(2839, "feat(gh): add the pane", { body: LONG_BODY })],
		issues: [issue(2801, "[Bug]: accepting an invitation answers the previous company", { body: LONG_BODY })],
	});
}

// The indicator the pane shows when the description does not fit: the exact
// range it is showing, out of how many rows.
const AT_TOP = /lines 1–\d+ of \d+/;

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

test("the detail pane shows the description under the metadata, wrapped to its width", () => {
	const body =
		"The description has to reach the pane with every word it arrived with, wrapped rather than clipped at the pane's edge, and it has to keep going long enough to prove the wrapping on more than one row.";
	const { view } = viewOf(snapshot({ pullRequests: [pull(7, "a title", { body })] }), 24);
	const detail = detailRows(view.render(120));
	const joined = detail.join(" ").replace(/\s+/g, " ");
	assert.ok(joined.includes("every word it arrived with"), "the description is on screen");
	assert.ok(joined.includes("more than one row."), "the end of the paragraph is rendered, not clipped away");
	assert.ok(detail.filter((row) => row.length > 0 && body.includes(row)).length >= 2, "the paragraph is wrapped, not one clipped row");
});

test("an unbreakable token is hard-split instead of overflowing the pane", () => {
	const token = "z".repeat(200);
	const { lines } = ghBodyLines(token, 40);
	assert.equal(lines.join(""), token, "every character survives the split");
	for (const line of lines) assert.ok(visibleWidth(line) <= 40, `line wider than the pane: ${visibleWidth(line)}`);

	const { view } = viewOf(snapshot({ pullRequests: [pull(7, "a title", { body: token })] }), 12);
	for (const width of [80, 120]) {
		for (const row of view.render(width)) assert.ok(visibleWidth(row) <= width, `over-wide row at ${width}: ${JSON.stringify(row)}`);
	}
});

test("blank lines in the description stay paragraph breaks", () => {
	const { view } = viewOf(snapshot({ pullRequests: [pull(7, "a title", { body: "first paragraph\n\nsecond paragraph" })] }));
	const detail = detailRows(view.render(120));
	const at = detail.indexOf("first paragraph");
	assert.ok(at >= 0, "the first paragraph is on screen");
	assert.equal(detail[at + 1], "", "the blank line keeps a row of its own");
	assert.equal(detail[at + 2], "second paragraph");
});

test("a description past the cap is cut and says where the rest is", () => {
	assert.equal(BODY_MAX_BYTES, 64 * 1024);
	assert.equal(BODY_MAX_LINES, 1000);
	assert.match(BODY_TRUNCATED, /browser/i, "the notice names where the full text is");

	const byLines = Array.from({ length: BODY_MAX_LINES + 25 }, (_, index) => `row ${index}`).join("\n");
	const clipped = ghBodyLines(byLines, 60);
	assert.equal(clipped.truncated, true);
	assert.equal(clipped.lines.length, BODY_MAX_LINES, "the cap is the last row kept");

	const byBytes = ghBodyLines("é".repeat(BODY_MAX_BYTES), 60);
	assert.equal(byBytes.truncated, true, "the byte cap bites before the line cap");

	const short = ghBodyLines("a description", 60);
	assert.equal(short.truncated, false);
	assert.deepEqual(short.lines, ["a description"]);

	// The notice is not just computed, it is what the pane shows at the end.
	const { view } = viewOf(snapshot({ pullRequests: [pull(7, "a title", { body: byLines })] }), 12);
	view.render(120);
	for (let press = 0; press < 200; press += 1) view.handleInput("\u001b[6~");
	assert.equal(detailRows(view.render(120)).at(-1), BODY_TRUNCATED);
});

test("a description that fits shows no scroll indicator, a taller one says which lines are on screen", () => {
	const short = viewOf(snapshot({ pullRequests: [pull(7, "a title", { body: "a short description" })] }), 12);
	assert.doesNotMatch(detailRows(short.view.render(120))[0]!, /lines \d+–\d+ of/);

	const tall = viewOf(longSnapshot(), 12);
	assert.match(detailRows(tall.view.render(120))[0]!, AT_TOP, "the pane shows the range it is drawing, so scroll is discoverable");
});

test("pageup and pagedown move the description a page, ctrl+j and ctrl+k a row", () => {
	// Twelve rows, three of chrome, and the detail header stays pinned: eight
	// rows of description are one page.
	const page = 12 - 3 - 1;
	const { view } = viewOf(longSnapshot(), 12);
	assert.match(detailRows(view.render(120))[0]!, AT_TOP);

	view.handleInput("\u001b[6~");
	assert.match(detailRows(view.render(120))[0]!, new RegExp(`lines ${page + 1}–${page * 2} of \\d+`), "one page is every description row the frame had");
	view.handleInput("\u001b[5~");
	assert.match(detailRows(view.render(120))[0]!, AT_TOP);
	view.handleInput("\u001b[5~");
	assert.match(detailRows(view.render(120))[0]!, AT_TOP, "the top is the top");

	// ctrl+j arrives as a bare line feed and ctrl+k as a vertical tab.
	view.handleInput("\n");
	assert.match(detailRows(view.render(120))[0]!, /lines 2–9 of \d+/);
	view.handleInput("\u000b");
	assert.match(detailRows(view.render(120))[0]!, AT_TOP);
});

test("the description goes back to the top when the selection, the tab or the state changes", () => {
	const { view } = viewOf(longSnapshot(), 12);
	view.render(120);
	view.handleInput("\u001b[6~");
	assert.doesNotMatch(detailRows(view.render(120))[0]!, AT_TOP, "the description really moved");

	view.handleInput("j");
	assert.match(detailRows(view.render(120))[0]!, AT_TOP, "the next item starts at its own top");

	view.handleInput("\u001b[6~");
	view.handleInput("\t");
	assert.match(detailRows(view.render(120))[0]!, AT_TOP, "the other tab starts at the top");

	view.handleInput("\u001b[6~");
	view.handleInput("s");
	assert.match(detailRows(view.render(120))[0]!, AT_TOP, "a new state drops the scroll with the rows it belonged to");
});

test("an empty description says so instead of leaving the detail pane blank", () => {
	const empty = viewOf(snapshot({ pullRequests: [pull(7, "no body here", { body: "" })] }));
	assert.match(detailRows(empty.view.render(120)).join("\n"), /no description/i);

	const blank = viewOf(snapshot({ pullRequests: [pull(7, "whitespace only", { body: " \n \n " })] }));
	assert.match(detailRows(blank.view.render(120)).join("\n"), /no description/i, "whitespace is an empty description too");
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
	for (const hint of ["esc", "tab/shift+tab", "j/k", "pgup/pgdn", "ctrl+j/k", "enter", "o", "y", "r", "s state"]) assert.ok(footer.includes(hint), `footer should mention ${hint}`);
	// Nothing may be clipped away: at eighty columns the last hint still has its label.
	assert.match(view.render(80).at(-1)!, /s state/);
	for (const width of [50, 80, 120]) assert.doesNotMatch(view.render(width).at(-1)!, /…/, `the footer is clipped at ${width}`);
});

test("the view fills its height exactly and never paints a row wider than the terminal", () => {
	for (const value of [FULL, longSnapshot()]) {
		for (const lines of [8, 12, 24]) {
			const { view } = viewOf(value, lines);
			for (const width of [20, 50, 80, 120]) {
				const rendered = view.render(width);
				assert.equal(rendered.length, Math.max(4, lines), `height at ${width}x${lines}`);
				for (const line of rendered) assert.ok(visibleWidth(line) <= width, `over-wide row at ${width}: ${JSON.stringify(line)}`);
			}
		}
	}
});

test("a wide terminal splits into a list and a detail pane", () => {
	const layout = ghViewLayout(140);
	assert.equal(layout.mode, "split");
	assert.ok(layout.listWidth >= 24 && layout.listWidth <= 44, `list width ${layout.listWidth}`);
	assert.equal(layout.listWidth + layout.detailWidth + PANE_SEPARATOR.length, 140, "the gutter is counted inside the terminal width");
});

test("the two panes are separated by a three-column rule, so the list has an edge", () => {
	assert.equal(PANE_SEPARATOR, " │ ");
	const { view } = viewOf(FULL);
	const body = view.render(120).slice(1, -1);
	assert.ok(body.some((row) => row.includes(PANE_SEPARATOR)), "the gutter is painted between the panes");
	for (const row of body) assert.equal(visibleWidth(row), 120, "the gutter is inside the terminal width, not on top of it");
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
