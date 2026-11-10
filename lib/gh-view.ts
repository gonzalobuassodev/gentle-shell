// Gentle Shell GitHub overlay: open pull requests and open issues, one flat
// selection, one detail pane. A plain class with injected dependencies, like
// WorktreeChangesView, so every row and every keystroke is testable without a
// terminal, and so nothing here knows about the Pi extension API.

import { fitPanelLine, type PanelTheme } from "./shell-panel.ts";
import { ghCounts, type GhSnapshot } from "./gh-state.ts";
import type { GithubRepo } from "./gh-client.ts";

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
const CHROME_ROWS = 2;
const SEPARATOR = " ";
const SELECTED = "▸";
const UNSELECTED = " ";
const EMPTY_TEXT = "none open";
const LOADING_TEXT = "loading…";
const NO_REMOTE_TEXT = "no GitHub remote";
const FOOTER = "esc close · j/k move · enter open · o browser · y copy · r refresh";

export function ghEntries(snapshot: GhSnapshot): GhEntry[] {
	const entries: GhEntry[] = snapshot.pullRequests.map((pull) => ({
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
	for (const issue of snapshot.issues) {
		entries.push({
			kind: "issue" as const,
			number: issue.number,
			title: issue.title,
			author: issue.author,
			updatedAt: issue.updatedAt,
			labels: issue.labels,
			commentCount: issue.commentCount,
		});
	}
	return entries;
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
	private index = 0;
	private disposed = false;

	constructor(deps: GhViewDeps) {
		this.deps = deps;
	}

	selected(): GhEntry | undefined {
		const entries = ghEntries(this.deps.snapshot());
		if (entries.length === 0) return undefined;
		this.index = Math.min(Math.max(0, this.index), entries.length - 1);
		return entries[this.index];
	}

	render(width: number): string[] {
		const target = Math.max(1, Math.floor(width));
		const height = Math.max(CHROME_ROWS + 1, this.rows());
		const snapshot = this.deps.snapshot();
		const entries = ghEntries(snapshot);
		const bodyRows = height - CHROME_ROWS;

		const lines = [this.header(snapshot, target)];
		lines.push(...this.body(snapshot, entries, target, bodyRows));
		lines.push(this.footer(target));
		while (lines.length > height) lines.pop();
		while (lines.length < height) lines.push(fitPanelLine("", "", target));
		return lines;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (data === "\u001b[B" || data === "j") return this.move(1);
		if (data === "\u001b[A" || data === "k") return this.move(-1);
		if (data === "\r" || data === "\n" || data === " " || data === "o") return this.open();
		if (data === "y") return this.copy();
		if (data === "r") {
			this.deps.refresh();
			this.deps.requestRender();
			return;
		}
		if (data === "\u001b" || data === "q") {
			this.deps.close();
			return;
		}
	}

	handleMouse(): void {}

	/** Repaint after the store changed underneath: the selection stays, clamped. */
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

	private move(delta: number): void {
		const entries = ghEntries(this.deps.snapshot());
		if (entries.length === 0) return;
		this.index = Math.min(Math.max(0, this.index + delta), entries.length - 1);
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
		const title = `${theme.fg("accent", "✿")} ${theme.bold ? theme.bold("GitHub") : "GitHub"} · ${name}`;
		const status = snapshot.status === "error" ? theme.fg("error", "unavailable") : snapshot.status === "loading" ? theme.fg("dim", LOADING_TEXT) : theme.fg("dim", this.countsText(snapshot));
		return fitPanelLine(title, status, width);
	}

	private countsText(snapshot: GhSnapshot): string {
		const counts = ghCounts(snapshot);
		const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
		return `${plural(counts.pullRequests, "pull request", "pull requests")} · ${plural(counts.issues, "issue", "issues")}`;
	}

	private footer(width: number): string {
		return fitPanelLine(this.deps.theme.fg("dim", FOOTER), "", width);
	}

	private body(snapshot: GhSnapshot, entries: GhEntry[], width: number, rows: number): string[] {
		if (entries.length === 0) return this.emptyBody(snapshot, width, rows);
		const layout = ghViewLayout(width);
		const list = this.listRows(snapshot, entries, layout.listWidth, rows);
		while (list.length < rows) list.push("");
		if (layout.mode === "list") return list.map((row) => fitPanelLine(row, "", width));
		const detail = this.detailRows(entries[Math.min(this.index, entries.length - 1)]!, layout.detailWidth, rows);
		return list.map((row, index) => `${fitPanelLine(row, "", layout.listWidth)}${SEPARATOR}${fitPanelLine(detail[index] ?? "", "", layout.detailWidth)}`);
	}

	private emptyBody(snapshot: GhSnapshot, width: number, rows: number): string[] {
		const theme = this.deps.theme;
		const text = snapshot.status === "error" ? (snapshot.error ?? "gh unavailable") : snapshot.status === "ready" ? EMPTY_TEXT : LOADING_TEXT;
		const role = snapshot.status === "error" ? "error" : "dim";
		const lines = ["", `  ${theme.fg(role, text)}`];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows).map((line) => fitPanelLine(line, "", width));
	}

	private listRows(snapshot: GhSnapshot, entries: GhEntry[], width: number, rows: number): string[] {
		const theme = this.deps.theme;
		const built: Array<{ text: string; entry?: number }> = [];
		let entryIndex = 0;
		const pushGroup = (title: string, count: number) => {
			if (count === 0) return;
			built.push({ text: fitPanelLine(`${theme.fg("muted", "▾")} ${theme.bold ? theme.bold(title) : title}`, theme.fg("muted", String(count)), width) });
		};
		pushGroup("Pull requests", snapshot.pullRequests.length);
		for (const pull of snapshot.pullRequests) {
			built.push({ text: this.itemRow(pull.number, pull.title, width), entry: entryIndex });
			entryIndex += 1;
		}
		pushGroup("Issues", snapshot.issues.length);
		for (const issue of snapshot.issues) {
			built.push({ text: this.itemRow(issue.number, issue.title, width), entry: entryIndex });
			entryIndex += 1;
		}
		return scrollToSelection(built, Math.min(this.index, entries.length - 1), rows);
	}

	private itemRow(number: number, title: string, width: number): string {
		return fitPanelLine(`${this.markerFor(number)} #${number} ${title}`, "", width);
	}

	private markerFor(number: number): string {
		return this.selected()?.number === number ? this.deps.theme.fg("accent", SELECTED) : UNSELECTED;
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
function scrollToSelection(built: Array<{ text: string; entry?: number }>, selectedIndex: number, rows: number): string[] {
	if (built.length <= rows) return built.map((row) => row.text);
	const selectedRow = built.findIndex((row) => row.entry === selectedIndex);
	const anchor = selectedRow === -1 ? 0 : selectedRow;
	const top = Math.min(Math.max(0, anchor - 1), Math.max(0, built.length - rows));
	return built.slice(top, top + rows).map((row) => row.text);
}
