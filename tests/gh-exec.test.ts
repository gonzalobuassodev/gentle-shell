import assert from "node:assert/strict";
import test from "node:test";
import { issueListArgs, prListArgs, repoFullName, type GithubRepo } from "../lib/gh-client.ts";
import { createGhDataSource, GH_FAILED, type GhExec, type GhExecResult, type GhGitRemote } from "../lib/gh-exec.ts";

// The exec layer is the only place the pane reaches the machine, so what a test
// can pin here is what the extension cannot get wrong: which directory the
// remote comes from, that every list is `gh`'s stdout parsed, and that a failing
// `gh` reaches the store as the tool's own error line instead of a silent empty
// list.

const REMOTE = "git@github.com:Gentleman-Programming/gentle-shell.git";
const REPO: GithubRepo = { host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" };
const PR_JSON = JSON.stringify([
	{
		number: 42,
		title: "Add the GitHub pane",
		author: { login: "someone" },
		isDraft: true,
		headRefName: "feat/gh-pane",
		updatedAt: "2026-11-10T09:00:00Z",
		labels: [{ name: "feature" }],
		comments: [],
		reviewDecision: null,
	},
]);
const ISSUE_JSON = JSON.stringify([
	{ number: 3076, title: "GitHub pane", author: { login: "someone" }, labels: [], comments: [{}, {}], updatedAt: "2026-11-10T08:00:00Z" },
]);

// An answer `gh` gives without a process: stdout on a zero exit, stderr otherwise.
const ok = (stdout: string): GhExecResult => ({ ok: true, stdout, stderr: "" });
const failed = (stderr: string): GhExecResult => ({ ok: false, stdout: "", stderr });

function sourceWith(answers: { remote?: string; exec?: GhExec }): ReturnType<typeof createGhDataSource> {
	const gitRemote: GhGitRemote = () => answers.remote;
	const exec: GhExec = answers.exec ?? (async () => ok("[]"));
	return createGhDataSource({ cwd: "/repo", gitRemote, exec });
}

test("the repository is resolved from the origin remote git reports in the session directory", () => {
	const seen: string[] = [];
	const gitRemote: GhGitRemote = (cwd) => {
		seen.push(cwd);
		return `${REMOTE}\n`;
	};
	const source = createGhDataSource({ cwd: "/repo", gitRemote, exec: async () => ok("[]") });
	assert.deepEqual(source.resolveRepo(), REPO);
	assert.deepEqual(seen, ["/repo"]);
});

test("no origin, or a host that is not GitHub, never asks gh anything", async () => {
	const missing = createGhDataSource({ cwd: "/repo", gitRemote: () => undefined, exec: async () => ok("[]") });
	assert.equal(missing.resolveRepo(), null);
	// The layer keeps the host it saw: rejecting a non-GitHub remote is the
	// store's decision (NOT_GITHUB_ERROR), so the pane can say why it is empty.
	const elsewhere = createGhDataSource({ cwd: "/repo", gitRemote: () => "git@gitlab.com:acme/widget.git", exec: async () => ok("[]") });
	assert.deepEqual(elsewhere.resolveRepo(), { host: "gitlab.com", owner: "acme", name: "widget" });
});

test("a failing gh becomes the tool's own stderr, trimmed, or a readable fallback", async () => {
	const failing = sourceWith({ remote: REMOTE, exec: async () => failed("  gh: not authenticated; run gh auth login\n\n") });
	const shape = (message: string) => (error: unknown) => error instanceof Error && error.message === message;
	await assert.rejects(failing.loadPullRequests(REPO), shape("gh: not authenticated; run gh auth login"));
	await assert.rejects(failing.loadIssues(REPO), shape("gh: not authenticated; run gh auth login"));

	const silent = sourceWith({ remote: REMOTE, exec: async () => failed("   \n") });
	await assert.rejects(silent.loadPullRequests(REPO), shape(GH_FAILED));
});

test("both lists are gh's stdout for the open work of that repository, parsed", async () => {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const exec: GhExec = async (args, cwd): Promise<GhExecResult> => {
		calls.push({ args, cwd });
		return ok(args[0] === "pr" ? PR_JSON : ISSUE_JSON);
	};
	const source = sourceWith({ remote: REMOTE, exec });

	assert.equal(repoFullName(REPO), "Gentleman-Programming/gentle-shell");
	assert.deepEqual(await source.loadPullRequests(REPO), [
		{
			number: 42,
			title: "Add the GitHub pane",
			author: "someone",
			isDraft: true,
			headRefName: "feat/gh-pane",
			updatedAt: "2026-11-10T09:00:00Z",
			labels: ["feature"],
			commentCount: 0,
			reviewDecision: null,
		},
	]);
	assert.deepEqual(await source.loadIssues(REPO), [
		{ number: 3076, title: "GitHub pane", author: "someone", labels: [], commentCount: 2, updatedAt: "2026-11-10T08:00:00Z" },
	]);
	// Argument vectors, not a command line: nothing is quoted or reinterpreted.
	assert.deepEqual(calls, [
		{ args: prListArgs(REPO), cwd: "/repo" },
		{ args: issueListArgs(REPO), cwd: "/repo" },
	]);
});
