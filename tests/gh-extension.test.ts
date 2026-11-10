import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleGh from "../extensions/gentle-gh.ts";

// Pi does not close an open overlay when a command runs again, so a second
// `/gentle:gh` reaches the extension while the first pane is still opening. The
// extension owns that guard, and the minute ticker it starts is what a stacked
// overlay would leak: these tests count live intervals instead of trusting the
// code path.

type Interval = ReturnType<typeof setInterval>;

type Overlay = { done: (result: null) => void; render(width: number): string[] };

function countIntervals(t: TestContext): { live(): number } {
	const live = new Set<Interval>();
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	// The ticker is unref'd, so a leaked one would also outlive the test run
	// without ever showing up here; counting them is the only evidence.
	globalThis.setInterval = ((handler: () => void, ms: number) => {
		const id = realSetInterval(handler, ms);
		live.add(id);
		return id;
	}) as typeof globalThis.setInterval;
	globalThis.clearInterval = ((id?: Interval) => {
		if (id !== undefined) live.delete(id);
		realClearInterval(id as never);
	}) as typeof globalThis.clearInterval;
	t.after(() => {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	});
	return { live: () => live.size };
}

type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;

function fakePi(): { pi: ExtensionAPI; handler(): Handler } {
	let registered: { description: string; handler: Handler } | undefined;
	const pi = {
		registerCommand: (name: string, definition: { description: string; handler: Handler }) => {
			assert.equal(name, "gentle:gh");
			registered = definition;
		},
		on: () => {},
		registerShortcut: () => {},
	} as unknown as ExtensionAPI;
	return {
		pi,
		handler: () => {
			assert.ok(registered, "the extension must register /gentle:gh");
			return registered.handler;
		},
	};
}

function fakeCtx(cwd: string): { ctx: ExtensionContext; overlays: Overlay[]; notifications: string[] } {
	const overlays: Overlay[] = [];
	const notifications: string[] = [];
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd,
		ui: {
			notify: (message: string) => notifications.push(message),
			setWidget: () => {},
			// The overlay stays open until its own close handler runs, exactly like
			// an overlay the user has not dismissed yet.
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: null) => void) => { render(width: number): string[] }) =>
				new Promise<null>((resolve) => {
					const done = (result: null) => resolve(result);
					const component = factory(tui, theme, {}, done);
					overlays.push({ done, render: (width: number) => component.render(width) });
				}),
		},
	} as unknown as ExtensionContext;
	return { ctx, overlays, notifications };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a second /gentle:gh while the first is opening mounts one overlay and one ticker", async (t) => {
	const counters = countIntervals(t);
	const scratch = mkdtempSync(join(tmpdir(), "gentle-gh-extension-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const { pi, handler } = fakePi();
	gentleGh(pi);
	const command = handler();
	const { ctx, overlays, notifications } = fakeCtx(scratch);

	await Promise.all([command("", ctx), command("", ctx)]);
	await flush();

	assert.deepEqual(
		{ overlays: overlays.length, tickers: counters.live() },
		{ overlays: 1, tickers: 1 },
		"a repeated command must not stack a second overlay or a second ticker",
	);
	assert.deepEqual(notifications, []);
	assert.ok(overlays[0]!.render(80).length > 0, "the single overlay paints");

	overlays[0]!.done(null);
	await flush();
	assert.equal(counters.live(), 0, "closing the pane clears its ticker");

	// The guard must be released by the same cleanup that clears the ticker, or
	// the pane would open exactly once per session.
	await command("", ctx);
	await flush();
	assert.equal(overlays.length, 2, "closing releases the guard");
	assert.equal(counters.live(), 1);

	overlays[1]!.done(null);
	await flush();
	assert.equal(counters.live(), 0);
});
