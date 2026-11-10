// Gentle Shell GitHub overlay: the repository's pull requests and issues as two
// tabs, one selection per tab, one detail pane. A plain class with injected
// dependencies, like WorktreeChangesView, so every row and every keystroke is
// testable without a terminal, and so nothing here knows about the Pi extension
// API.

import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fitPanelLine, type PanelTheme } from "./shell-panel.ts";
import { ghCounts, type GhSnapshot } from "./gh-state.ts";
import { ghCountLabel, type GhStateFilter, type GithubRepo } from "./gh-client.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export type GhEntryKind = "pr" | "issue";

export interface GhEntry {
	kind: GhEntryKind;
	number: number;
	title: string;
	author: string;
	body: string;
	updatedAt: string;
	labels: string[];
	commentCount: number;
	isDraft?: boolean;
	headRefName?: string;
	reviewDecision?: string | null;
}

export type GhViewTheme = PanelTheme;

export interface GhViewDeps {
	theme: GhViewTheme;
	rows: number | (() => number);
	snapshot(): GhSnapshot;
	openUrl(url: string): void;
	copy(text: string): void;
	refresh(): void;
	/** Hands one tab's next state to the store, which answers it with a real fetch. */
	cycleState(kind: GhEntryKind): void;
	close(): void;
	requestRender(): void;
}

export interface GhViewLayout {
	mode: "split" | "list";
	listWidth: number;
	detailWidth: number;
}

export const GH_COMMAND = "/gentle:gh";
export const GH_SPLIT_MIN_WIDTH = 70;
export const GH_LIST_MIN_WIDTH = 24;
export const GH_LIST_MAX_WIDTH = 44;
// A description is the one thing in this pane that is as tall as its author
// made it, so it is the one thing that needs a bound: past either limit the
// pane shows BODY_TRUNCATED in place of the rest instead of drawing a megabyte
// of prose one keystroke at a time.
export const BODY_MAX_BYTES = 64 * 1024;
export const BODY_MAX_LINES = 1000;
export const BODY_TRUNCATED = "Description cut — the full text is in the browser.";
const NO_DESCRIPTION = "no description";
// Header, tab row, footer: the list and the detail pane share what is left.
const CHROME_ROWS = 3;
// Three columns, not one: a bare gap leaves the eye to guess where the list
// stops and the detail starts. The rule is painted with the dim role in body().
export const PANE_SEPARATOR = " │ ";
const TAB_SEPARATOR = "│";
const SELECTED = "▸";
const UNSELECTED = " ";
const TABS: readonly GhEntryKind[] = ["pr", "issue"];
const TAB_LABEL: Record<GhEntryKind, string> = { pr: "Pull requests", issue: "Issues" };
const TAB_SCOPE: Record<GhEntryKind, string> = { pr: "pull requests", issue: "issues" };
const LOADING_TEXT = "loading…";
const NO_REMOTE_TEXT = "no GitHub remote";
// Named keys, not glyphs: this is the only place the pane says what the keys do,
// and it has to fit eighty columns without dropping a control. Each tier names
// the same keys in less space, and the last one that fits is the one drawn.
const FOOTER_TIERS = [
	"esc close · tab/shift+tab · j/k · pgup/pgdn · ctrl+j/k scroll · enter/o open · y copy · r refresh · s state",
	"esc · tab · j/k · pgup/pgdn scroll · ctrl+j/k · enter/o · y · r · s state",
	"esc · j/k · pgup/pgdn · ctrl+j/k · o · y · r · s",
] as const;

// The empty body names the tab and the state it is asking for: "none open" under
// a closed tab reads as a lie about a different question.
function emptyText(kind: GhEntryKind, state: GhStateFilter): string {
	const subject = kind === "pr" ? "pull requests" : "issues";
	return state === "all" ? `no ${subject} at all` : `no ${subject} ${state}`;
}

export function ghEntries(snapshot: GhSnapshot, kind: GhEntryKind): GhEntry[] {
	if (kind === "pr") {
		return snapshot.pullRequests.map((pull) => ({
			kind: "pr" as const,
			number: pull.number,
			title: pull.title,
			author: pull.author,
			body: pull.body,
			updatedAt: pull.updatedAt,
			labels: pull.labels,
			commentCount: pull.commentCount,
			isDraft: pull.isDraft,
			headRefName: pull.headRefName,
			reviewDecision: pull.reviewDecision,
		}));
	}
	return snapshot.issues.map((issue) => ({
		kind: "issue" as const,
		number: issue.number,
		title: issue.title,
		author: issue.author,
		body: issue.body,
		updatedAt: issue.updatedAt,
		labels: issue.labels,
		commentCount: issue.commentCount,
	}));
}

/**
 * The description as pane rows: wrapped to `width`, its own blank lines kept as
 * paragraph breaks, and cut at the cap. `truncated` is a flag rather than text
 * so the caller can paint the notice it adds with the role it deserves.
 */
export function ghBodyLines(body: string, width: number): { lines: string[]; truncated: boolean } {
	const target = Math.max(1, Math.floor(width));
	// A description is author-written text from the far side of the network, so
	// its control sequences never reach the terminal, and a tab becomes spaces so
	// a wrapped row cannot land past the pane's edge.
	const text = sanitizeTerminalText(body ?? "").replace(/\t/g, "  ");
	if (text.trim().length === 0) return { lines: [], truncated: false };
	const clipped = clipBody(text);
	const lines = clipped.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, target));
	return { lines, truncated: clipped.cut };
}

function clipBody(text: string): { text: string; cut: boolean } {
	const lines = text.split("\n");
	const cut = lines.length > BODY_MAX_LINES;
	const kept = (cut ? lines.slice(0, BODY_MAX_LINES) : lines).join("\n");
	if (Buffer.byteLength(kept, "utf8") > BODY_MAX_BYTES) return { text: clipUtf8(kept, BODY_MAX_BYTES), cut: true };
	return { text: kept, cut };
}

// Cuts on a character boundary so a multi-byte character is never split in half.
function clipUtf8(text: string, maxBytes: number): string {
	let used = 0;
	let end = 0;
	for (const character of text) {
		used += Buffer.byteLength(character, "utf8");
		if (used > maxBytes) break;
		end += character.length;
	}
	return text.slice(0, end);
}

export function ghItemUrl(repo: GithubRepo, entry: { kind: GhEntryKind; number: number }): string {
	const path = entry.kind === "pr" ? "pull" : "issues";
	return `https://${repo.host}/${repo.owner}/${repo.name}/${path}/${entry.number}`;
}

export function ghViewLayout(width: number): GhViewLayout {
	const target = Math.max(0, Math.floor(width));
	if (target < GH_SPLIT_MIN_WIDTH) return { mode: "list", listWidth: target, detailWidth: 0 };
	const listWidth = Math.min(GH_LIST_MAX_WIDTH, Math.max(GH_LIST_MIN_WIDTH, Math.round(target * 0.4)));
	return { mode: "split", listWidth, detailWidth: Math.max(0, target - listWidth - PANE_SEPARATOR.length) };
}

export class GhView {
	private readonly deps: GhViewDeps;
	// The pane opens on pull requests, and only the tab on screen draws a list.
	private tab: GhEntryKind = "pr";
	// One row remembered per tab: moving in Issues must not lose the row held in
	// Pull requests.
	private readonly selectedRow: Record<GhEntryKind, number> = { pr: 0, issue: 0 };
	// The description scrolls inside its own column, so where it sits belongs to
	// one row of one tab in one state: scrollKey names that, and any change of key
	// puts the description back at its top instead of at a stranger's offset.
	private scrollTop = 0;
	private scrollKey = "";
	// What the last frame drew, so a scroll keystroke moves inside the layout on
	// screen instead of inventing one from a width that was never rendered.
	private frame: { width: number; rows: number } = { width: 0, rows: 0 };
	private disposed = false;

	constructor(deps: GhViewDeps) {
		this.deps = deps;
	}

	selected(): GhEntry | undefined {
		const entries = this.entries();
		if (entries.length === 0) return undefined;
		return entries[this.clampSelection(entries)];
	}

	render(width: number): string[] {
		const target = Math.max(1, Math.floor(width));
		const height = Math.max(CHROME_ROWS + 1, this.rows());
		const snapshot = this.deps.snapshot();
		const bodyRows = height - CHROME_ROWS;
		this.frame = { width: target, rows: bodyRows };

		const lines = [this.header(snapshot, target), this.tabRow(snapshot, target)];
		lines.push(...this.body(snapshot, this.entries(), target, bodyRows));
		lines.push(this.footer(target));
		while (lines.length > height) lines.pop();
		while (lines.length < height) lines.push(fitPanelLine("", "", target));
		return lines;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (data === "\t" || data === "l") return this.switchTab(1);
		if (data === "\u001b[Z" || data === "h") return this.switchTab(-1);
		// ctrl+j arrives as a bare line feed, which pi also reads as enter, so the
		// scroll keys are checked before the open key; a real Enter is CR.
		if (matchesKey(data, Key.pageDown)) return this.scrollBody(this.pageRows());
		if (matchesKey(data, Key.pageUp)) return this.scrollBody(-this.pageRows());
		if (matchesKey(data, Key.ctrl("j"))) return this.scrollBody(1);
		if (matchesKey(data, Key.ctrl("k"))) return this.scrollBody(-1);
		if (data === "\u001b[B" || data === "j") return this.move(1);
		if (data === "\u001b[A" || data === "k") return this.move(-1);
		if (data === "\r" || data === " " || data === "o") return this.open();
		if (data === "y") return this.copy();
		if (data === "r") {
			this.deps.refresh();
			this.deps.requestRender();
			return;
		}
		if (data === "s") {
			// The state belongs to the tab on screen: merged is a pull request answer,
			// and asking gh for merged issues is a state it does not have.
			this.deps.cycleState(this.tab);
			this.deps.requestRender();
			return;
		}
		if (data === "\u001b" || data === "q") {
			this.deps.close();
			return;
		}
	}

	handleMouse(): void {}

	/** Repaint after the store changed underneath: each tab's selection is clamped. */
	update(): void {
		if (!this.disposed) this.deps.requestRender();
	}

	dispose(): void {
		this.disposed = true;
	}

	private rows(): number {
		const rows = this.deps.rows;
		return typeof rows === "function" ? rows() : rows;
	}

	private entries(): GhEntry[] {
		return ghEntries(this.deps.snapshot(), this.tab);
	}

	private stateOf(snapshot: GhSnapshot): GhStateFilter {
		return this.tab === "pr" ? snapshot.prState : snapshot.issueState;
	}

	/** The selected row of the active tab, clamped to what is actually there. */
	private clampSelection(entries: GhEntry[]): number {
		const row = Math.min(Math.max(0, this.selectedRow[this.tab]), Math.max(0, entries.length - 1));
		this.selectedRow[this.tab] = row;
		return row;
	}

	private switchTab(delta: number): void {
		const at = TABS.indexOf(this.tab);
		this.tab = TABS[(at + delta + TABS.length) % TABS.length]!;
		this.deps.requestRender();
	}

	private move(delta: number): void {
		const entries = this.entries();
		if (entries.length === 0) return;
		this.selectedRow[this.tab] = Math.min(Math.max(0, this.selectedRow[this.tab] + delta), entries.length - 1);
		this.deps.requestRender();
	}

	private open(): void {
		const entry = this.selected();
		const repo = this.deps.snapshot().repo;
		if (!entry || !repo) return;
		this.deps.openUrl(ghItemUrl(repo, entry));
		this.deps.requestRender();
	}

	private copy(): void {
		const entry = this.selected();
		if (!entry) return;
		this.deps.copy(`#${entry.number}`);
		this.deps.requestRender();
	}

	private header(snapshot: GhSnapshot, width: number): string {
		const theme = this.deps.theme;
		const name = snapshot.repo ? `${snapshot.repo.owner}/${snapshot.repo.name}` : NO_REMOTE_TEXT;
		// The state qualifies the tab on screen, so it belongs in the title: the
		// status slot says loading or unavailable instead and would hide it exactly
		// when the pane has nothing else to say.
		const scope = `${TAB_SCOPE[this.tab]} ${this.stateOf(snapshot)}`;
		const title = `${theme.fg("accent", "✿")} ${theme.bold ? theme.bold("GitHub") : "GitHub"} · ${name} · ${theme.fg("accent", scope)}`;
		const status = snapshot.status === "error" ? theme.fg("error", "unavailable") : snapshot.status === "loading" ? theme.fg("dim", LOADING_TEXT) : "";
		return fitPanelLine(title, status, width);
	}

	private tabRow(snapshot: GhSnapshot, width: number): string {
		const theme = this.deps.theme;
		const counts = ghCounts(snapshot);
		const tab = (kind: GhEntryKind, withCount: boolean): string => {
			const label = withCount ? `${TAB_LABEL[kind]} ${ghCountLabel(kind === "pr" ? counts.pullRequests : counts.issues)}` : TAB_LABEL[kind];
			return theme.fg(this.tab === kind ? "accent" : "dim", label);
		};
		const row = (withCount: boolean) => ` ${TABS.map((kind) => tab(kind, withCount)).join(` ${TAB_SEPARATOR} `)} `;
		const full = row(true);
		// The counts are the first thing to drop: both tabs stay visible on a narrow
		// pane, because the one that is not on screen is how a person knows it exists.
		return fitPanelLine(visibleWidth(full) <= width ? full : row(false), "", width);
	}

	private footer(width: number): string {
		const tier = FOOTER_TIERS.find((candidate) => visibleWidth(candidate) <= width) ?? FOOTER_TIERS[FOOTER_TIERS.length - 1]!;
		return fitPanelLine(this.deps.theme.fg("dim", tier), "", width);
	}

	private body(snapshot: GhSnapshot, entries: GhEntry[], width: number, rows: number): string[] {
		if (entries.length === 0) return this.emptyBody(snapshot, width, rows);
		const selected = this.clampSelection(entries);
		const layout = ghViewLayout(width);
		const list = this.listRows(entries, selected, layout.listWidth, rows);
		if (layout.mode === "list") return list.map((row) => fitPanelLine(row, "", width));
		const detail = this.detailRows(entries[selected]!, layout.detailWidth, rows);
		return list.map((row, index) => `${fitPanelLine(row, "", layout.listWidth)}${this.deps.theme.fg("dim", PANE_SEPARATOR)}${fitPanelLine(detail[index] ?? "", "", layout.detailWidth)}`);
	}

	private emptyBody(snapshot: GhSnapshot, width: number, rows: number): string[] {
		const theme = this.deps.theme;
		const text =
			snapshot.status === "error" ? (snapshot.error ?? "gh unavailable") : snapshot.status === "ready" ? emptyText(this.tab, this.stateOf(snapshot)) : LOADING_TEXT;
		const role = snapshot.status === "error" ? "error" : "dim";
		const lines = ["", `  ${theme.fg(role, text)}`];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows).map((line) => fitPanelLine(line, "", width));
	}

	private listRows(entries: GhEntry[], selected: number, width: number, rows: number): string[] {
		const theme = this.deps.theme;
		const painted = entries.map((entry, index) =>
			fitPanelLine(`${index === selected ? theme.fg("accent", SELECTED) : UNSELECTED} #${entry.number} ${entry.title}`, "", width),
		);
		const window = scrollToSelection(painted, selected, rows);
		while (window.length < rows) window.push("");
		return window;
	}

	/**
	 * Everything the detail pane scrolls, under the row that names the item: the
	 * header stays put so a scrolled description never loses which item it is.
	 */
	private detailLines(entry: GhEntry, width: number): string[] {
		const theme = this.deps.theme;
		const stamp = entry.updatedAt.slice(0, 10);
		const facts = [entry.author, entry.headRefName ?? "", stamp].filter((part) => part.length > 0);
		const state: string[] = [];
		if (entry.kind === "pr") state.push(entry.isDraft ? "draft" : "ready for review");
		if (entry.kind === "pr" && entry.reviewDecision) state.push(entry.reviewDecision.toLowerCase().replace(/_/g, " "));
		state.push(`${entry.commentCount} ${entry.commentCount === 1 ? "comment" : "comments"}`);
		return [
			"",
			fitPanelLine(entry.title, "", width),
			"",
			fitPanelLine(theme.fg("dim", facts.join(" · ")), "", width),
			fitPanelLine(theme.fg("dim", state.join(" · ")), "", width),
			fitPanelLine(theme.fg("dim", entry.labels.join(", ")), "", width),
			// A blank row keeps the description from reading as one more fact row.
			"",
			...this.descriptionLines(entry, width),
		];
	}

	private detailHeader(entry: GhEntry, width: number, indicator = ""): string {
		const theme = this.deps.theme;
		const bold = theme.bold ?? ((text: string) => text);
		const kind = entry.kind === "pr" ? "Pull request" : "Issue";
		return fitPanelLine(bold(`#${entry.number} ${kind}`), indicator.length > 0 ? theme.fg("dim", indicator) : "", width);
	}

	private descriptionLines(entry: GhEntry, width: number): string[] {
		const theme = this.deps.theme;
		const target = Math.max(1, Math.floor(width));
		const body = ghBodyLines(entry.body, target);
		if (body.lines.length === 0) return [fitPanelLine(theme.fg("dim", NO_DESCRIPTION), "", target)];
		const rows = body.lines.map((line) => fitPanelLine(line, "", target));
		// The cut is the pane's doing, so the pane names it: a description that just
		// stops would read as a description that ended there.
		if (body.truncated) for (const line of wrapTextWithAnsi(BODY_TRUNCATED, target)) rows.push(fitPanelLine(theme.fg("dim", line), "", target));
		return rows;
	}

	/**
	 * The detail pane: the item's header, then the window of its content from the
	 * remembered offset, clamped so the last row is always a real one. When there
	 * is more content than a frame, the header says which part is on screen.
	 */
	private detailRows(entry: GhEntry, width: number, rows: number): string[] {
		const content = this.detailLines(entry, width);
		const visible = Math.max(0, rows - 1);
		const top = this.syncScroll(entry, content.length, visible);
		const end = Math.min(content.length, top + visible);
		const indicator = content.length > visible && visible > 0 ? `lines ${top + 1}–${end} of ${content.length}` : "";
		const lines = [this.detailHeader(entry, width, indicator), ...content.slice(top, end)];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	/**
	 * Keeps the offset inside the description it belongs to, and returns it: the
	 * key changes whenever the selection, the tab or the state does, and that is
	 * what puts a new description back at the top.
	 */
	private syncScroll(entry: GhEntry, total: number, rows: number): number {
		const key = `${this.tab}:${this.stateOf(this.deps.snapshot())}:${entry.kind}-${entry.number}`;
		if (key !== this.scrollKey) {
			this.scrollKey = key;
			this.scrollTop = 0;
		}
		this.scrollTop = Math.min(Math.max(0, this.scrollTop), Math.max(0, total - rows));
		return this.scrollTop;
	}

	private scrollBody(delta: number): void {
		const entry = this.selected();
		if (!entry) return;
		const detailWidth = ghViewLayout(this.frame.width).detailWidth;
		const visible = Math.max(0, this.frame.rows - 1);
		const total = detailWidth > 0 ? this.detailLines(entry, detailWidth).length : 0;
		const top = this.syncScroll(entry, total, visible);
		this.scrollTop = Math.min(Math.max(0, top + delta), Math.max(0, total - visible));
		this.deps.requestRender();
	}

	/** One page of description: the body rows, minus the header that stays put. */
	private pageRows(): number {
		return Math.max(1, this.frame.rows - 1);
	}
}

// Rows to keep the selected entry on screen, with one row of context above it.
function scrollToSelection(rows: string[], selectedIndex: number, maxRows: number): string[] {
	if (rows.length <= maxRows) return [...rows];
	const top = Math.min(Math.max(0, selectedIndex - 1), Math.max(0, rows.length - maxRows));
	return rows.slice(top, top + maxRows);
}
