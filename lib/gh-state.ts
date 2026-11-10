// Gentle Shell GitHub state: what was fetched, when, and whether it failed.
// The rail and the overlay both read this one store, so a keystroke repaint
// never reaches the network and a cached rail frame cannot outlive its data.
// The two tabs are kept apart on purpose: each has its own state, its own rows
// and its own failure, so moving one never rewrites the other.

import {
	DEFAULT_GH_STATE,
	GITHUB_HOST,
	nextIssueState,
	nextPrState,
	type GhStateFilter,
	type GithubRepo,
	type IssueStateFilter,
	type IssueSummary,
	type PullRequestSummary,
} from "./gh-client.ts";

export type GhStatus = "idle" | "loading" | "ready" | "error";
/** The two lists the pane keeps apart: pull requests, and issues. */
export type GhKind = "pr" | "issue";

export interface GhSnapshot {
	repo: GithubRepo | null;
	/** The pull request tab's state: the header names it and the digest carries it. */
	prState: GhStateFilter;
	/** The issue tab's state, which never holds merged: gh counts no merged issue. */
	issueState: IssueStateFilter;
	pullRequests: PullRequestSummary[];
	issues: IssueSummary[];
	status: GhStatus;
	error: string | null;
	loadedAt: number | null;
	/** Bumped by every applied result, including a failure: the rail digest reads it. */
	version: number;
}

export interface GhDeps {
	now(): number;
	resolveRepo(): GithubRepo | null;
	loadPullRequests(repo: GithubRepo, state: GhStateFilter): Promise<PullRequestSummary[]>;
	loadIssues(repo: GithubRepo, state: IssueStateFilter): Promise<IssueSummary[]>;
	onChange(): void;
}

// GitHub changes when somebody else acts, so a refresh per minute is already
// generous; anything faster spends the API budget on a screen nobody is reading.
export const GH_TTL_MS = 60_000;
export const NO_REMOTE_ERROR = "No git remote here: nothing to ask GitHub about.";
export const NOT_GITHUB_ERROR = "Only github.com is supported; this remote points elsewhere.";

/** Where a snapshot is read: the overlay the user is on, or the rail's digest. */
type Surface = "filtered" | "openWork";
// One list, asked of gh for one state. The two arms are what keeps merged a pull
// request question: an issue question cannot carry a state gh would reject.
type Question = { kind: "pr"; state: GhStateFilter } | { kind: "issue"; state: IssueStateFilter };
/** How one list stands on one surface: the two tabs load, age and fail apart. */
interface KindLoad {
	status: GhStatus;
	error: string | null;
	loadedAt: number | null;
}

const IDLE_LOAD: KindLoad = { status: "idle", error: null, loadedAt: null };

function isStaleSnapshot(snapshot: GhSnapshot, now: number): boolean {
	return snapshot.loadedAt === null || now - snapshot.loadedAt >= GH_TTL_MS;
}

function isStaleLoad(load: KindLoad, now: number): boolean {
	return load.loadedAt === null || now - load.loadedAt >= GH_TTL_MS;
}

function keyOf(question: Question): string {
	return `${question.kind}:${question.state}`;
}

function stateOf(snapshot: GhSnapshot, kind: GhKind): GhStateFilter {
	return kind === "pr" ? snapshot.prState : snapshot.issueState;
}

function combinedStatus(loads: Record<GhKind, KindLoad>): GhStatus {
	const states = [loads.pr.status, loads.issue.status];
	// Loading outranks everything, so a half-answered refresh never claims to be
	// done; the error outranks the rows, so a tab that still has rows cannot hide
	// the failure that keeps them.
	if (states.includes("loading")) return "loading";
	if (states.includes("error")) return "error";
	if (states.includes("ready")) return "ready";
	return "idle";
}

// The surface is only as fresh as its stalest list: the digest ages on the one
// that is about to be re-read, not on the one that just landed.
function stalestLoadedAt(loads: Record<GhKind, KindLoad>): number | null {
	const stamps = [loads.pr.loadedAt, loads.issue.loadedAt];
	if (stamps.some((stamp) => stamp === null)) return null;
	return Math.min(...(stamps as number[]));
}

export class GhStore {
	private readonly deps: GhDeps;
	// One store, two surfaces: the states and rows the overlay is showing, and the
	// open work the rail digests. A rail that reported closed or merged counts
	// because the overlay moved would stop being a digest of what is open now.
	private filtered: GhSnapshot;
	private openWork: GhSnapshot;
	private readonly loads: Record<Surface, Record<GhKind, KindLoad>>;
	// Keyed by list and state, so a switch never borrows the answer to a different
	// question and an answer for the tab the user just left cannot land in it.
	private readonly inFlight = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(deps: GhDeps) {
		this.deps = deps;
		const initial: GhSnapshot = {
			repo: deps.resolveRepo(),
			prState: DEFAULT_GH_STATE,
			issueState: DEFAULT_GH_STATE,
			pullRequests: [],
			issues: [],
			status: "idle",
			error: null,
			loadedAt: null,
			version: 0,
		};
		this.filtered = initial;
		this.openWork = initial;
		this.loads = {
			filtered: { pr: IDLE_LOAD, issue: IDLE_LOAD },
			openWork: { pr: IDLE_LOAD, issue: IDLE_LOAD },
		};
	}

	/** What the overlay shows: the two tabs as the user left them. */
	snapshot(): GhSnapshot {
		return this.filtered;
	}

	/** What the rail digests: always the open work, never the overlay's states. */
	openSnapshot(): GhSnapshot {
		return this.openWork;
	}

	isStale(): boolean {
		return isStaleSnapshot(this.filtered, this.deps.now());
	}

	async refresh(force = false): Promise<GhSnapshot> {
		if (this.disposed) return this.filtered;
		const questions = this.questions();
		const repo = this.deps.resolveRepo();
		if (!repo) return this.fail(NO_REMOTE_ERROR, questions);
		if (repo.host !== GITHUB_HOST) return this.fail(NOT_GITHUB_ERROR, questions);
		await Promise.all(questions.map((question) => this.fetch(question, repo, force)));
		return this.filtered;
	}

	/** Moves one tab to its next state, and re-reads only that tab's list. */
	async cycleState(kind: GhKind): Promise<GhSnapshot> {
		if (this.disposed) return this.filtered;
		let question: Question;
		if (kind === "pr") {
			const state = nextPrState(this.filtered.prState);
			question = { kind, state };
			// The other tab keeps its state, its rows and the row it was on: they answer
			// a different question, and one list must never wear the other's label.
			this.filtered = { ...this.filtered, prState: state, pullRequests: [] };
		} else {
			const state = nextIssueState(this.filtered.issueState);
			question = { kind, state };
			this.filtered = { ...this.filtered, issueState: state, issues: [] };
		}
		// The rows are gone and so is their age: the TTL says nothing about a
		// question nobody has asked, and a failure here is retried, not remembered.
		this.loads.filtered[kind] = IDLE_LOAD;
		this.publish("filtered", this.filtered);
		const repo = this.deps.resolveRepo();
		// A missing or non-GitHub remote is a fact about the repository, not about
		// the state, so it is answered rather than waited on.
		if (!repo) return this.fail(NO_REMOTE_ERROR, [question]);
		if (repo.host !== GITHUB_HOST) return this.fail(NOT_GITHUB_ERROR, [question]);
		await this.fetch(question, repo, true);
		return this.filtered;
	}

	dispose(): void {
		this.disposed = true;
		this.inFlight.clear();
	}

	/** Every list on screen: the overlay's pair, and the rail's open pair. */
	private questions(): Question[] {
		const wanted: Question[] = [
			{ kind: "pr", state: this.filtered.prState },
			{ kind: "issue", state: this.filtered.issueState },
			{ kind: "pr", state: DEFAULT_GH_STATE },
			{ kind: "issue", state: DEFAULT_GH_STATE },
		];
		// Both tabs on open is one question, not four: one fetch answers the overlay
		// and the rail together.
		const seen = new Set<string>();
		return wanted.filter((question) => {
			const key = keyOf(question);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	/** The surfaces still asking this question; empty means the answer is unwanted now. */
	private targetsFor(kind: GhKind, state: GhStateFilter): Surface[] {
		const targets: Surface[] = [];
		if (stateOf(this.filtered, kind) === state) targets.push("filtered");
		// The rail's surface is pinned to open work for both lists, whatever the tabs ask.
		if (state === DEFAULT_GH_STATE) targets.push("openWork");
		return targets;
	}

	private fetch(question: Question, repo: GithubRepo, force: boolean): Promise<void> {
		const key = keyOf(question);
		const pending = this.inFlight.get(key);
		if (pending) return pending;
		const targets = this.targetsFor(question.kind, question.state);
		if (targets.length === 0) return Promise.resolve();
		if (!force && targets.every((target) => !isStaleLoad(this.loads[target][question.kind], this.deps.now()))) {
			return Promise.resolve();
		}

		// A pending fetch is not a result: the version the rail memo reads moves when
		// rows or a failure land, not when the pane starts waiting for them.
		for (const target of targets) this.patch(target, question.kind, { status: "loading", error: null });
		this.emit();
		const load = this.load(question, repo);
		this.inFlight.set(key, load);
		return load;
	}

	private async load(question: Question, repo: GithubRepo): Promise<void> {
		try {
			if (question.kind === "pr") {
				const rows = await this.deps.loadPullRequests(repo, question.state);
				this.land(question, (target) => ({ ...this[target], pullRequests: rows }));
			} else {
				const rows = await this.deps.loadIssues(repo, question.state);
				this.land(question, (target) => ({ ...this[target], issues: rows }));
			}
			this.emit();
		} catch (error) {
			if (this.disposed) return;
			// A failed refresh keeps the last good rows: a stale list is more use
			// than an empty one, and the error line says so.
			const message = error instanceof Error ? error.message : String(error);
			for (const target of this.targetsFor(question.kind, question.state)) this.patch(target, question.kind, { status: "error", error: message }, true);
			this.emit();
		} finally {
			this.inFlight.delete(keyOf(question));
		}
	}

	/** Lands one list's rows on every surface still asking for them. */
	private land(question: Question, next: (target: Surface) => GhSnapshot): void {
		if (this.disposed) return;
		for (const target of this.targetsFor(question.kind, question.state)) {
			this.loads[target][question.kind] = { status: "ready", error: null, loadedAt: this.deps.now() };
			this.publish(target, next(target), true);
		}
	}

	private patch(target: Surface, kind: GhKind, load: Partial<KindLoad>, bump = false): void {
		this.loads[target][kind] = { ...this.loads[target][kind], ...load };
		this.publish(target, this[target], bump);
	}

	/** A snapshot's status, error and age are always its two loads combined. */
	private publish(target: Surface, next: GhSnapshot, bump = false): void {
		const loads = this.loads[target];
		this[target] = {
			...next,
			status: combinedStatus(loads),
			error: loads.pr.error ?? loads.issue.error,
			loadedAt: stalestLoadedAt(loads),
			version: next.version + (bump ? 1 : 0),
		};
	}

	/** A repository-level failure answers every question that was asked, once each. */
	private fail(message: string, questions: Question[]): GhSnapshot {
		const repo = this.deps.resolveRepo();
		for (const question of questions) {
			for (const target of this.targetsFor(question.kind, question.state)) {
				this[target] = { ...this[target], repo };
				this.patch(target, question.kind, { status: "error", error: message }, true);
			}
		}
		this.emit();
		return this.filtered;
	}

	private emit(): void {
		if (!this.disposed) this.deps.onChange();
	}
}

export function ghCounts(snapshot: GhSnapshot): { pullRequests: number; issues: number } {
	return { pullRequests: snapshot.pullRequests.length, issues: snapshot.issues.length };
}

// The rail memoizes each part by its digest, so the digest has to change when
// the data changes, when that data ages past one TTL, and when either tab's state
// changes: a frame of open work is not the frame the merged and closed pair asks
// for, at the same version and the same age.
export function ghDigest(snapshot: GhSnapshot, now: number): string {
	const age = snapshot.loadedAt === null ? "none" : String(Math.floor(Math.max(0, now - snapshot.loadedAt) / GH_TTL_MS));
	return `${snapshot.prState}:${snapshot.issueState}:${snapshot.version}:${age}`;
}
