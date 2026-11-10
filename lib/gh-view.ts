// Gentle Shell GitHub overlay: the repository's pull requests and issues as two
// tabs, one selection per tab, one detail pane. A plain class with injected
// dependencies, like WorktreeChangesView, so every row and every keystroke is
// testable without a terminal, and so nothing here knows about the Pi extension
// API.

import { visibleWidth } from "@earendil-works/pi-tui";
import { fitPanelLine, type PanelTheme } from "./shell-panel.ts";
import { ghCounts, type GhSnapshot } from "./gh-state.ts";
import { ghCountLabel, type GhStateFilter, type GithubRepo } from "./gh-client.ts";

export type GhEntryKind = "pr" | "issue";

export interface GhEntry {
	kind: GhEntryKind;
	number: number;
	title: string;
	author: string;
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
// Header, tab row, footer: the list and the detail pane share what is left.
const CHROME_ROWS = 3;
const SEPARATOR = " ";
const TAB_SEPARATOR = "│";
const SELECTED = "▸";
const UNSELECTED = " ";
const TABS: readonly GhEntryKind[] = ["pr", "issue"];
const TAB_LABEL: Record<GhEntryKind, string> = { pr: "Pull requests", issue: "Issues" };
const TAB_SCOPE: Record<GhEntryKind, string> = { pr: "pull requests", issue: "issues" };
const LOADING_TEXT = "loading…";
const NO_REMOTE_TEXT = "no GitHub remote";
// Named keys, not glyphs: this is the only place the pane says what `s` and the
// tabs do, and it has to fit eighty columns without dropping a control.
const FOOTER = "esc close · tab/shift+tab · j/k · enter/o open · y copy · r refresh · s state";

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
		updatedAt: issue.updatedAt,
		labels: issue.labels,
		commentCount: issue.commentCount,
	}));
}

export function ghItemUrl(repo: GithubRepo, entry: { kind: GhEntryKind; number: number }): string {
	const path = entry.kind === "pr" ? "pull" : "issues";
	return `https://${repo.host}/${repo.owner}/${repo.name}/${path}/${entry.number}`;
}

export function ghViewLayout(width: number): GhViewLayout {
	const target = Math.max(0, Math.floor(width));
	if (target < GH_SPLIT_MIN_WIDTH) return { mode: "list", listWidth: target, detailWidth: 0 };
	const listWidth = Math.min(GH_LIST_MAX_WIDTH, Math.max(GH_LIST_MIN_WIDTH, Math.round(target * 0.4)));
	return { mode: "split", listWidth, detailWidth: Math.max(0, target - listWidth - SEPARATOR.length) };
}

export class GhView {
	private readonly deps: GhViewDeps;
	// The pane opens on pull requests, and only the tab on screen draws a list.
	private tab: GhEntryKind = "pr";
	// One row remembered per tab: moving in Issues must not lose the row held in
	// Pull requests.
	private readonly selectedRow: Record<GhEntryKind, number> = { pr: 0, issue: 0 };
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
		if (data === "\u001b[B" || data === "j") return this.move(1);
		if (data === "\u001b[A" || data === "k") return this.move(-1);
		if (data === "\r" || data === "\n" || data === " " || data === "o") return this.open();
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
		return fitPanelLine(this.deps.theme.fg("dim", FOOTER), "", width);
	}

	private body(snapshot: GhSnapshot, entries: GhEntry[], width: number, rows: number): string[] {
		if (entries.length === 0) return this.emptyBody(snapshot, width, rows);
		const selected = this.clampSelection(entries);
		const layout = ghViewLayout(width);
		const list = this.listRows(entries, selected, layout.listWidth, rows);
		if (layout.mode === "list") return list.map((row) => fitPanelLine(row, "", width));
		const detail = this.detailRows(entries[selected]!, layout.detailWidth, rows);
		return list.map((row, index) => `${fitPanelLine(row, "", layout.listWidth)}${SEPARATOR}${fitPanelLine(detail[index] ?? "", "", layout.detailWidth)}`);
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

	private detailRows(entry: GhEntry, width: number, rows: number): string[] {
		const theme = this.deps.theme;
		const bold = theme.bold ?? ((text: string) => text);
		const kind = entry.kind === "pr" ? "Pull request" : "Issue";
		const stamp = entry.updatedAt.slice(0, 10);
		const facts = [entry.author, entry.headRefName ?? "", stamp].filter((part) => part.length > 0);
		const state: string[] = [];
		if (entry.kind === "pr") state.push(entry.isDraft ? "draft" : "ready for review");
		if (entry.kind === "pr" && entry.reviewDecision) state.push(entry.reviewDecision.toLowerCase().replace(/_/g, " "));
		state.push(`${entry.commentCount} ${entry.commentCount === 1 ? "comment" : "comments"}`);
		const lines = [
			fitPanelLine(bold(`#${entry.number} ${kind}`), "", width),
			"",
			fitPanelLine(entry.title, "", width),
			"",
			fitPanelLine(theme.fg("dim", facts.join(" · ")), "", width),
			fitPanelLine(theme.fg("dim", state.join(" · ")), "", width),
			fitPanelLine(theme.fg("dim", entry.labels.join(", ")), "", width),
		];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}
}

// Rows to keep the selected entry on screen, with one row of context above it.
function scrollToSelection(rows: string[], selectedIndex: number, maxRows: number): string[] {
	if (rows.length <= maxRows) return [...rows];
	const top = Math.min(Math.max(0, selectedIndex - 1), Math.max(0, rows.length - maxRows));
	return rows.slice(top, top + maxRows);
}
