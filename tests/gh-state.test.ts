import assert from "node:assert/strict";
import test from "node:test";
import { GhStore, GH_TTL_MS, ghCounts, ghDigest, type GhDeps } from "../lib/gh-state.ts";
import type { GhStateFilter, GithubRepo, IssueSummary, PullRequestSummary } from "../lib/gh-client.ts";

// The store owns everything the pane shows that is not a keyboard event: what
// was fetched, when, whether it failed, and the version the rail memo reads so
// a cached frame cannot outlive the data it was painted from. It keeps the two
// tabs apart on purpose, so a state, a fetch or a failure of one never reaches
// the other.

const REPO: GithubRepo = { host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" };

function pull(number: number): PullRequestSummary {
	return {
		number,
		title: `pr ${number}`,
		author: "someone",
		body: "",
		isDraft: false,
		headRefName: `feat/${number}`,
		updatedAt: "2026-11-10T09:00:00Z",
		labels: [],
		commentCount: 0,
		reviewDecision: null,
	};
}

function issue(number: number): IssueSummary {
	return { number, title: `issue ${number}`, author: "someone", body: "", labels: [], commentCount: 0, updatedAt: "2026-11-10T09:00:00Z" };
}

interface Harness {
	deps: GhDeps;
	changes: number;
	calls: { prs: number; issues: number };
	asked(): { prs: GhStateFilter[]; issues: GhStateFilter[] };
	setRepo(repo: GithubRepo | null): void;
	advance(ms: number): void;
}

function harness(overrides: Partial<GhDeps> = {}): Harness {
	const state = { now: 1_000_000, repo: REPO as GithubRepo | null, changes: 0, calls: { prs: 0, issues: 0 } };
	const asked: { prs: GhStateFilter[]; issues: GhStateFilter[] } = { prs: [], issues: [] };
	const deps: GhDeps = {
		now: () => state.now,
		resolveRepo: () => state.repo,
		loadPullRequests: async (_repo, filter) => {
			state.calls.prs += 1;
			asked.prs.push(filter);
			return [pull(1), pull(2)];
		},
		loadIssues: async (_repo, filter) => {
			state.calls.issues += 1;
			asked.issues.push(filter);
			return [issue(10)];
		},
		onChange: () => {
			state.changes += 1;
		},
		...overrides,
	};
	return {
		deps,
		get changes() {
			return state.changes;
		},
		calls: state.calls,
		asked: () => ({ prs: [...asked.prs], issues: [...asked.issues] }),
		setRepo(repo) {
			state.repo = repo;
		},
		advance(ms) {
			state.now += ms;
		},
	};
}

test("a fresh store is idle, empty, and already knows its repository and both tabs", () => {
	const { deps } = harness();
	const store = new GhStore(deps);
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "idle");
	assert.equal(snapshot.prState, "open", "the pane opens on open pull requests");
	assert.equal(snapshot.issueState, "open", "and on open issues");
	assert.deepEqual(snapshot.repo, REPO);
	assert.deepEqual(snapshot.pullRequests, []);
	assert.deepEqual(snapshot.issues, []);
	assert.equal(snapshot.version, 0);
	assert.equal(snapshot.error, null);
});

test("refresh loads each list once and repaints through onChange", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "ready");
	assert.deepEqual(snapshot.pullRequests.map((p) => p.number), [1, 2]);
	assert.deepEqual(snapshot.issues.map((i) => i.number), [10]);
	assert.ok(snapshot.version > 0, "new data must move the version the rail memo reads");
	assert.equal(snapshot.loadedAt, 1_000_000);
	assert.ok(h.changes > 0, "the pane must be told to repaint");
	assert.deepEqual(h.asked(), { prs: ["open"], issues: ["open"] }, "both tabs on open is one fetch per list");
});

test("a second refresh inside the TTL reuses the data instead of calling gh again", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	const version = store.snapshot().version;
	h.advance(GH_TTL_MS - 1);
	await store.refresh();
	assert.equal(h.calls.prs, 1);
	assert.equal(h.calls.issues, 1);
	assert.equal(store.snapshot().version, version, "a cached answer is not a new result");
});

test("the TTL expiring makes the next refresh a real fetch", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	const version = store.snapshot().version;
	h.advance(GH_TTL_MS);
	await store.refresh();
	assert.equal(h.calls.prs, 2);
	assert.ok(store.snapshot().version > version);
});

test("a forced refresh ignores the TTL, which is what r does", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	await store.refresh(true);
	assert.equal(h.calls.prs, 2);
	assert.equal(h.calls.issues, 2);
});

test("concurrent refreshes share one in-flight fetch", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
	assert.equal(h.calls.prs, 1);
	assert.equal(h.calls.issues, 1);
});

test("a failure keeps the last good rows and reports the reason", async () => {
	let fail = false;
	const h = harness({
		loadPullRequests: async () => {
			if (fail) throw new Error("gh: not authenticated");
			return [pull(1)];
		},
	});
	const store = new GhStore(h.deps);
	await store.refresh();
	fail = true;
	h.advance(GH_TTL_MS);
	await store.refresh();
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "error");
	assert.match(String(snapshot.error), /not authenticated/);
	assert.deepEqual(snapshot.pullRequests.map((p) => p.number), [1], "a failed refresh must not blank the pane");
	assert.ok(snapshot.version > 0, "the error is a visible change");
});

test("one list failing leaves the other list's rows and its tab alone", async () => {
	let fail = false;
	const h = harness({
		loadIssues: async () => {
			if (fail) throw new Error("gh: not authenticated");
			return [issue(10)];
		},
	});
	const store = new GhStore(h.deps);
	await store.refresh();
	fail = true;
	h.advance(GH_TTL_MS);
	await store.refresh();
	const snapshot = store.snapshot();
	assert.deepEqual(snapshot.pullRequests.map((p) => p.number), [1, 2], "the pull request tab still has its rows");
	assert.deepEqual(snapshot.issues.map((i) => i.number), [10], "the failing tab keeps its last good rows too");
	assert.equal(snapshot.status, "error");
	assert.match(String(snapshot.error), /not authenticated/);
});

test("no GitHub remote is an error the pane can explain, not a crash", async () => {
	const h = harness();
	h.setRepo(null);
	const store = new GhStore(h.deps);
	await store.refresh();
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "error");
	assert.equal(snapshot.repo, null);
	assert.match(String(snapshot.error), /remote/i);
	assert.equal(h.calls.prs, 0, "nothing to ask gh about");
});

test("a non-GitHub host is refused instead of being asked of gh", async () => {
	const h = harness();
	h.setRepo({ host: "gitlab.com", owner: "acme", name: "widget" });
	const store = new GhStore(h.deps);
	await store.refresh();
	assert.equal(store.snapshot().status, "error");
	assert.match(String(store.snapshot().error), /github\.com/);
	assert.equal(h.calls.prs, 0);
});

test("a disposed store stops loading and stops repainting", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	store.dispose();
	const changesAfterDispose = h.changes;
	await store.refresh(true);
	assert.equal(h.calls.prs, 0);
	assert.equal(h.changes, changesAfterDispose);
});

test("ghCounts is what the rail header prints", () => {
	const { deps } = harness();
	const store = new GhStore(deps);
	assert.deepEqual(ghCounts(store.snapshot()), { pullRequests: 0, issues: 0 });
});

test("ghDigest changes when the data changes and when the TTL bucket rolls", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	const before = ghDigest(store.snapshot(), 1_000_000);
	await store.refresh();
	const afterLoad = ghDigest(store.snapshot(), 1_000_000);
	assert.notEqual(afterLoad, before, "new data must break the rail memo");

	const sameBucket = ghDigest(store.snapshot(), 1_000_000 + GH_TTL_MS - 1);
	assert.equal(sameBucket, afterLoad, "one paint inside the bucket must stay cached");

	const nextBucket = ghDigest(store.snapshot(), 1_000_000 + GH_TTL_MS);
	assert.notEqual(nextBucket, afterLoad, "a rolled bucket must re-validate once");
});

test("s on the pull request tab advances only that tab, and asks gh for that listing alone", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	const issueVersion = store.snapshot().version;
	await store.cycleState("pr");
	const snapshot = store.snapshot();
	assert.equal(snapshot.prState, "closed");
	assert.equal(snapshot.issueState, "open", "the issue tab keeps the state the user left it on");
	assert.deepEqual(h.asked(), { prs: ["open", "closed"], issues: ["open"] }, "only the pull request list is re-read");
	assert.deepEqual(snapshot.issues.map((i) => i.number), [10], "the other tab keeps its rows while the fetch runs");
	assert.ok(snapshot.version > issueVersion, "the new rows move the digest");
});

test("s on the issue tab advances only that tab, and never asks gh for merged", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	await store.cycleState("issue");
	assert.equal(store.snapshot().issueState, "closed");
	assert.equal(store.snapshot().prState, "open", "the pull request tab was not moved");
	assert.deepEqual(h.asked(), { prs: ["open"], issues: ["open", "closed"] });
	await store.cycleState("issue");
	await store.cycleState("issue");
	assert.equal(store.snapshot().issueState, "open", "open, closed, all, and back");
	assert.equal(h.asked().issues.includes("merged" as GhStateFilter), false, "gh rejects --state merged for issues");
	assert.deepEqual(h.asked().prs, ["open"], "the pull request listing was never re-read");
});

test("the pull request cycle reaches merged without leaking it into the issue listing", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	await store.cycleState("pr");
	await store.cycleState("pr");
	const snapshot = store.snapshot();
	assert.equal(snapshot.prState, "merged");
	assert.equal(snapshot.issueState, "open", "merged is a pull request state; issues keep their own");
	assert.deepEqual(h.asked(), { prs: ["open", "closed", "merged"], issues: ["open"] });
	assert.ok(snapshot.pullRequests.length > 0, "the merged pull requests are the answer");
	assert.deepEqual(snapshot.issues.map((i) => i.number), [10], "the issue tab still shows its open issues");
});

test("ghDigest carries both tab states, so one pair's frame is never reused for another", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	const openPair = ghDigest(store.snapshot(), 1_000_000);
	await store.cycleState("issue");
	const issueClosed = ghDigest(store.snapshot(), 1_000_000);
	await store.cycleState("pr");
	const bothClosed = ghDigest(store.snapshot(), 1_000_000);
	assert.match(openPair, /^open:open:/);
	assert.match(issueClosed, /^open:closed:/, "the issue tab's state is in the digest");
	assert.match(bothClosed, /^closed:closed:/, "and so is the pull request tab's");
	assert.notEqual(issueClosed, openPair);
	assert.notEqual(bothClosed, issueClosed);
});

test("the rail's open snapshot is untouched by either tab's state", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	const openBefore = store.openSnapshot();
	await store.cycleState("pr");
	await store.cycleState("pr");
	await store.cycleState("issue");
	assert.equal(store.openSnapshot(), openBefore, "nothing re-read open work, so the rail's frame still stands");
	assert.equal(store.openSnapshot().prState, "open");
	assert.equal(store.openSnapshot().issueState, "open");
	assert.deepEqual(store.openSnapshot().pullRequests.map((entry) => entry.number), [1, 2]);
	assert.deepEqual(store.openSnapshot().issues.map((entry) => entry.number), [10]);
	assert.equal(store.snapshot().prState, "merged", "the pane moved on");
	assert.equal(store.snapshot().issueState, "closed");
});

test("a refresh while both tabs sit on other states still re-asks what the rail digests", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	await store.refresh();
	await store.cycleState("pr");
	await store.cycleState("issue");
	assert.deepEqual(h.asked(), { prs: ["open", "closed"], issues: ["open", "closed"] });
	h.advance(GH_TTL_MS);
	await store.refresh();
	assert.deepEqual(h.asked(), { prs: ["open", "closed", "closed", "open"], issues: ["open", "closed", "closed", "open"] }, "the open question never goes stale behind the tabs");
	assert.equal(store.snapshot().prState, "closed", "the pane keeps the states the user chose");
	assert.equal(store.snapshot().issueState, "closed");
	assert.deepEqual(store.openSnapshot().pullRequests.map((entry) => entry.number), [1, 2]);
});

test("a load for the tab's previous state cannot land in the new one", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const h = harness({
		loadPullRequests: async (_repo, state) => {
			if (state === "open") await gate;
			return state === "open" ? [pull(1)] : [pull(90)];
		},
	});
	const store = new GhStore(h.deps);
	const openLoad = store.refresh();
	await store.cycleState("pr");
	release();
	await openLoad;
	assert.equal(store.snapshot().prState, "closed");
	assert.deepEqual(store.snapshot().pullRequests.map((entry) => entry.number), [90]);
	assert.deepEqual(store.openSnapshot().pullRequests.map((entry) => entry.number), [1], "the open answer lands in the open surface");
});

test("a state the fetcher cannot answer never wears the previous rows", async () => {
	const h = harness({
		loadPullRequests: async (_repo, filter) => {
			if (filter === "merged") throw new Error("gh: rate limited");
			return [pull(1), pull(2)];
		},
	});
	const store = new GhStore(h.deps);
	await store.refresh();
	await store.cycleState("pr");
	await store.cycleState("pr");
	const snapshot = store.snapshot();
	assert.equal(snapshot.status, "error");
	assert.equal(snapshot.prState, "merged");
	assert.match(String(snapshot.error), /rate limited/);
	assert.deepEqual(snapshot.pullRequests, [], "closed rows must not be shown as merged work");
	assert.deepEqual(store.openSnapshot().pullRequests.map((entry) => entry.number), [1, 2], "the rail keeps its open digest");
});

test("a disposed store ignores a state change", async () => {
	const h = harness();
	const store = new GhStore(h.deps);
	store.dispose();
	await store.cycleState("pr");
	assert.equal(h.calls.prs, 0);
	assert.equal(store.snapshot().prState, "open");
});
