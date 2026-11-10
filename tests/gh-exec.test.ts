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
	await assert.rejects(failing.loadPullRequests(REPO, "open"), shape("gh: not authenticated; run gh auth login"));
	await assert.rejects(failing.loadIssues(REPO, "open"), shape("gh: not authenticated; run gh auth login"));

	const silent = sourceWith({ remote: REMOTE, exec: async () => failed("   \n") });
	await assert.rejects(silent.loadPullRequests(REPO, "open"), shape(GH_FAILED));
});

test("both lists are gh's stdout for the open work of that repository, parsed", async () => {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const exec: GhExec = async (args, cwd): Promise<GhExecResult> => {
		calls.push({ args, cwd });
		return ok(args[0] === "pr" ? PR_JSON : ISSUE_JSON);
	};
	const source = sourceWith({ remote: REMOTE, exec });

	assert.equal(repoFullName(REPO), "Gentleman-Programming/gentle-shell");
	assert.deepEqual(await source.loadPullRequests(REPO, "open"), [
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
	assert.deepEqual(await source.loadIssues(REPO, "open"), [
		{ number: 3076, title: "GitHub pane", author: "someone", labels: [], commentCount: 2, updatedAt: "2026-11-10T08:00:00Z" },
	]);
	// Argument vectors, not a command line: nothing is quoted or reinterpreted.
	assert.deepEqual(calls, [
		{ args: prListArgs(REPO, "open"), cwd: "/repo" },
		{ args: issueListArgs(REPO, "open"), cwd: "/repo" },
	]);
});

test("a tab's state reaches the listing it belongs to, and never the other one", async () => {
	const calls: string[][] = [];
	const exec: GhExec = async (args) => {
		calls.push(args);
		return ok("[]");
	};
	const source = sourceWith({ remote: REMOTE, exec });
	await source.loadPullRequests(REPO, "merged");
	await source.loadIssues(REPO, "all");
	const stateOf = (args: string[]) => args[args.indexOf("--state") + 1];
	assert.equal(stateOf(calls[0]!), "merged");
	assert.equal(stateOf(calls[1]!), "all");
	assert.equal(calls[0]![0], "pr", "merged is a pull request question");
	assert.equal(calls[1]![0], "issue");
});

test("the issue listing is only ever asked for a state gh accepts for issues", async () => {
	const calls: string[][] = [];
	const exec: GhExec = async (args) => {
		calls.push(args);
		return ok("[]");
	};
	const source = sourceWith({ remote: REMOTE, exec });
	for (const state of ["open", "closed", "all"] as const) await source.loadIssues(REPO, state);
	assert.deepEqual(calls.map((args) => args[args.indexOf("--state") + 1]), ["open", "closed", "all"]);
	for (const args of calls) {
		assert.equal(args[0], "issue");
		assert.ok(!args.includes("merged"), "gh rejects --state merged for issues");
	}
});

// The pane is read-only against GitHub (S6). The argument vectors are pinned
// here rather than trusted: a new flag or a new subcommand is the only way this
// layer could ever write, so an argument-level assertion is the real boundary.
const WRITE_CAPABLE = ["merge", "close", "create", "edit", "delete", "comment", "review", "reopen", "ready", "api", "--method", "--input", "-X"];

test("the only gh arguments the pane builds are the two listings, in any filter", () => {
	const vectors = [
		...(["open", "closed", "merged", "all"] as const).map((state) => ({ args: prListArgs(REPO, state), kind: "pr", state })),
		...(["open", "closed", "all"] as const).map((state) => ({ args: issueListArgs(REPO, state), kind: "issue", state })),
	];
	for (const { args, kind, state } of vectors) {
		assert.equal(args[0], kind);
		assert.equal(args[1], "list", "a listing is the only verb");
		assert.equal(args[args.indexOf("--state") + 1], state);
		assert.equal(args[args.length - 2], "--json");
		// Exactly one --repo, and it is the resolved repository, never a bare flag.
		assert.equal(args.filter((arg) => arg === "--repo").length, 1);
		assert.equal(args[args.indexOf("--repo") + 1], repoFullName(REPO));
		for (const arg of args) {
			// `comments` and `reviewDecision` are JSON field names, not verbs: the
			// check is an exact token match so a data field can never pass as one.
			assert.ok(!WRITE_CAPABLE.includes(arg), `${JSON.stringify(arg)} can write to GitHub`);
			assert.ok(!arg.startsWith("--method=") && !arg.startsWith("--input="), `${JSON.stringify(arg)} can write to GitHub`);
		}
	}
});

test("a repository whose name contains shell metacharacters stays one --repo argument", async () => {
	const hostile: GithubRepo = { host: "github.com", owner: "acme; rm -rf ~", name: "$(whoami)|`id`" };
	const calls: string[][] = [];
	const exec: GhExec = async (args) => {
		calls.push(args);
		return ok("[]");
	};
	// No shell is involved, so the metacharacters are only bytes in one argument.
	const source = createGhDataSource({ cwd: "/repo", gitRemote: () => "git@github.com:acme/repo.git", exec });
	await source.loadPullRequests(hostile, "open");
	await source.loadIssues(hostile, "open");

	assert.equal(calls.length, 2);
	for (const args of calls) {
		assert.equal(args.filter((arg) => arg === "--repo").length, 1);
		assert.equal(args[args.indexOf("--repo") + 1], `${hostile.owner}/${hostile.name}`);
		assert.ok(!args.some((arg) => arg === "rm" || arg === "-rf"), "no metacharacter became its own argument");
	}
});
