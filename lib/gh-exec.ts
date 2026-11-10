// Gentle Shell GitHub exec layer: the only place the pane runs `git` and `gh`.
// Both are argument vectors through execFile, never a shell. `gh` owns its own
// credentials (lib/gentle-shell-bundled.ts strips GH_TOKEN and GITHUB_TOKEN from
// the child env), so nothing here reads a token, and every command is a read.

import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from "node:child_process";
import {
	issueListArgs,
	parseIssues,
	parsePullRequests,
	parseRepoFromRemote,
	prListArgs,
	type GhStateFilter,
	type GithubRepo,
	type IssueStateFilter,
	type IssueSummary,
	type PullRequestSummary,
} from "./gh-client.ts";

/** One `gh` invocation's answer: whether it exited zero, its stdout, and what it wrote to stderr. */
export type GhExecResult = { ok: boolean; stdout: string; stderr: string };
/**
 * The machine seam, so a test answers without a process. It resolves rather than
 * throws on a non-zero exit, so the error line the store shows is built here.
 */
export type GhExec = (args: string[], cwd: string) => Promise<GhExecResult>;
/**
 * The remote read is synchronous: the store resolves the repository while it
 * renders a frame, and a frame cannot wait for a process. Undefined means git
 * could not answer — no origin, or not a repository at all.
 */
export type GhGitRemote = (cwd: string) => string | undefined;

export interface GhExecDeps {
	cwd: string;
	exec?: GhExec;
	gitRemote?: GhGitRemote;
}

export interface GhDataSource {
	resolveRepo(): GithubRepo | null;
	loadPullRequests(repo: GithubRepo, state: GhStateFilter): Promise<PullRequestSummary[]>;
	loadIssues(repo: GithubRepo, state: IssueStateFilter): Promise<IssueSummary[]>;
}

/** What a silent non-zero exit says instead: a missing `gh` writes nothing to stderr. */
export const GH_FAILED = "gh failed";
const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 20_000;
// `gh` prints its reason on stderr; that line, trimmed, is the message the
// store's error state and the overlay show.
function failure(stderr: string, fallback: string): string {
	const trimmed = stderr.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

const defaultGitRemote: GhGitRemote = (cwd) => {
	try {
		// execFileSync never goes through a shell: no quoting, no globbing.
		return String(nodeExecFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
	} catch {
		return undefined;
	}
};

const defaultExec: GhExec = (args, cwd) =>
	new Promise((resolve) => {
			nodeExecFile("gh", args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
			// The reason is stderr's: a non-zero exit and a missing binary both land here.
			if (error) {
				resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
				return;
			}
			resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});

/** The four dependencies the store asks for, bound to one session directory. */
export function createGhDataSource(deps: GhExecDeps): GhDataSource {
	const exec = deps.exec ?? defaultExec;
	const gitRemote = deps.gitRemote ?? defaultGitRemote;
	const remote = () => gitRemote(deps.cwd);
	const list = async (args: string[]): Promise<string> => {
		const result = await exec(args, deps.cwd);
		if (!result.ok) throw new Error(failure(result.stderr, GH_FAILED));
		return result.stdout;
	};
	return {
		// Resolution never throws: no origin and a remote git cannot answer are both
		// "no repository here", which the store already words for the pane.
		resolveRepo() {
			const url = remote();
			return url === undefined ? null : parseRepoFromRemote(url);
		},
		async loadPullRequests(repo, state) {
			return parsePullRequests(await list(prListArgs(repo, state)));
		},
		async loadIssues(repo, state) {
			return parseIssues(await list(issueListArgs(repo, state)));
		},
	};
}
