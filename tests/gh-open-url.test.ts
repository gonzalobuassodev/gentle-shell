import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { isGithubItemUrl, openGithubUrl } from "../lib/gh-open-url.ts";

// The pane hands a URL to the operating system's opener, so the guard is the
// whole safety story: only an issue or pull request page on github.com may
// reach a program that hands it to a browser.

type Call = { command: string; args: readonly string[]; options: Record<string, unknown> };

const PR_URL = "https://github.com/Gentleman-Programming/gentle-shell/pull/3077";
const ISSUE_URL = "https://github.com/Gentleman-Programming/gentle-shell/issues/3076";
const OPTIONS = { detached: true, stdio: "ignore", windowsHide: true, shell: false };

function fakeSpawn(outcome: "spawn" | "error" = "spawn") {
	const calls: Call[] = [];
	let unrefs = 0;
	const spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options });
		const child = Object.assign(new EventEmitter(), { unref: () => { unrefs++; } });
		queueMicrotask(() => outcome === "spawn" ? child.emit("spawn") : child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })));
		return child;
	};
	return { spawn: spawn as never, calls, unrefs: () => unrefs };
}

test("a pull request or issue URL opens in the platform browser", async () => {
	const fake = fakeSpawn();
	assert.deepEqual(await openGithubUrl(PR_URL, { platform: "darwin", spawn: fake.spawn }), { opened: true });
	assert.deepEqual(await openGithubUrl(ISSUE_URL, { platform: "darwin", spawn: fake.spawn }), { opened: true });
	assert.deepEqual(fake.calls, [
		{ command: "/usr/bin/open", args: [PR_URL], options: OPTIONS },
		{ command: "/usr/bin/open", args: [ISSUE_URL], options: OPTIONS },
	]);
	assert.equal(fake.unrefs(), 2);
});

test("anything that is not a github.com pull request or issue never reaches the opener", async () => {
	const refused = [
		"https://evil.example/Gentleman-Programming/gentle-shell/pull/1",
		"http://github.com/Gentleman-Programming/gentle-shell/pull/1",
		"https://github.com/Gentleman-Programming/gentle-shell/pull/1/",
		"https://github.com/Gentleman-Programming/gentle-shell/pull/1?tab=files",
		"https://github.com/Gentleman-Programming/gentle-shell/pull/abc",
		"https://github.com/Gentleman-Programming/gentle-shell",
		"file:///etc/passwd",
		"",
	];
	const fake = fakeSpawn();
	for (const url of refused) {
		assert.equal(isGithubItemUrl(url), false, `must refuse: ${url}`);
		assert.deepEqual(await openGithubUrl(url, { platform: "darwin", spawn: fake.spawn }), { opened: false, error: "only github.com pull request and issue pages can be opened" });
	}
	assert.deepEqual(fake.calls, []);
	assert.equal(isGithubItemUrl(PR_URL), true);
	assert.equal(isGithubItemUrl(ISSUE_URL), true);
});

test("a failing opener is reported, never thrown", async () => {
	const fake = fakeSpawn("error");
	assert.deepEqual(await openGithubUrl(PR_URL, { platform: "linux", spawn: fake.spawn }), { opened: false, error: "spawn xdg-open ENOENT" });
	assert.deepEqual(fake.calls, [{ command: "xdg-open", args: [PR_URL], options: OPTIONS }]);
});
