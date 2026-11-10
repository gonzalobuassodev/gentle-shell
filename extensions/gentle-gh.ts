// Gentle Shell GitHub pane: `/gentle:gh` over the rail's Github section.
// This extension is wiring only — which repository, when to refresh, and how a
// keystroke becomes a browser tab. Everything it shows lives in lib/gh-*:
// gh-client parses, gh-state stores, gh-view renders, gh-rail digests, and
// gh-exec is the one place a process runs.

import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { createGhDataSource } from "../lib/gh-exec.ts";
import { GITHUB_COMMAND, GITHUB_SECTION_KEY, GithubRail } from "../lib/gh-rail.ts";
import { GH_TTL_MS, GhStore } from "../lib/gh-state.ts";
import { GhView } from "../lib/gh-view.ts";
import { openGithubUrl } from "../lib/gh-open-url.ts";
import { createNativeFullscreenInteraction } from "../lib/native-fullscreen-interaction.ts";
import { withOverlayRepaint } from "../lib/overlay-repaint.ts";
import { sidebarPart } from "../lib/shell-sidebar.ts";
import { invalidateSidebar } from "../lib/shell-sidebar-layout.ts";

/** The rail ships the display form (`/gentle:gh`); the registrar wants it bare. */
const COMMAND_NAME = GITHUB_COMMAND.replace(/^\//, "");
const NO_TERMINAL = "The GitHub pane needs an interactive terminal.";

interface GhRuntime {
	cwd: string;
	ctx: ExtensionContext;
	store: GhStore;
	tui?: TUI;
}

let runtime: GhRuntime | undefined;
// Pi does not close an open overlay when its command runs again, so without this
// a second `/gentle:gh` mounts a second pane, a second ticker and a second view
// that nothing ever disposes. Set synchronously by showOverlay and cleared by the
// same `finally` that clears the ticker.
let overlayOpen = false;

// One runtime per session directory: a resumed session elsewhere resolves a
// different origin remote, and the previous store's pending load must not land
// in the new one.
function ensureRuntime(ctx: ExtensionContext): GhRuntime {
	if (runtime && runtime.cwd === ctx.cwd) {
		runtime.ctx = ctx;
		return runtime;
	}
	runtime?.store.dispose();
	const source = createGhDataSource({ cwd: ctx.cwd });
	const current: GhRuntime = {
		cwd: ctx.cwd,
		ctx,
		store: new GhStore({
			now: () => Date.now(),
			resolveRepo: () => source.resolveRepo(),
			loadPullRequests: (repo, state) => source.loadPullRequests(repo, state),
			loadIssues: (repo, state) => source.loadIssues(repo, state),
			// The rail memo cannot see a snapshot it never read: every applied
			// result bumps the revision so the section repaints.
			onChange: () => {
				if (current.tui) invalidateSidebar(current.tui);
			},
		}),
	};
	runtime = current;
	return current;
}

// Mounted like the Changes section: the below-editor component paints nothing
// (the rail is where it shows), and sidebarPart hands the rail its slot.
function mountSection(current: GhRuntime, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(
		GITHUB_SECTION_KEY,
		(tui, theme) => {
			current.tui = tui;
			return sidebarPart(
				tui,
				GITHUB_SECTION_KEY,
				{ render: () => [], invalidate() {}, dispose() {} },
				new GithubRail({
					theme,
					// The pinned open snapshot, not the overlay's: the section keeps counting
					// open work whatever filter the pane is showing.
					openSnapshot: () => current.store.openSnapshot(),
					now: () => Date.now(),
					open: () => openOverlay(current.ctx),
				}),
			);
		},
		{ placement: "belowEditor" },
	);
}

// The overlay takes the whole terminal, like Changes and Gentle Agents, and the
// native fullscreen wrapper keeps mouse dispatch on the view while it owns the
// keyboard.
async function showOverlay(current: GhRuntime): Promise<void> {
	const ctx = current.ctx;
	// Before the first await: openOverlay must see the guard during the initial
	// load, not only once the overlay has mounted.
	overlayOpen = true;
	let view: GhView | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	try {
		// The pane opens on data, not on a spinner: the first load lands before the
		// view asks the store for a snapshot.
		await current.store.refresh();
		await ctx.ui.custom<null>(
			(tui, theme, _keybindings, done) => {
				const close = withOverlayRepaint(tui, done);
				current.tui = tui;
				const ghView = new GhView({
					theme,
					rows: () => Math.max(0, tui.terminal.rows),
					snapshot: () => current.store.snapshot(),
					// Opening a link never blocks the frame: the failure is a notice.
					openUrl: (url) => {
						void openGithubUrl(url).then((result) => {
							if (!result.opened && result.error) ctx.ui.notify(result.error, "warning");
						});
					},
					copy: (text) => void copyToClipboard(text).catch(() => {}),
					refresh: () => {
						void current.store
							.refresh(true)
							.then(() => view?.update())
							.catch(() => {});
					},
					// The store answers a tab's state change with a real fetch of that list and
					// a new version, so the repaint waits for that answer instead of guessing
					// its rows.
					cycleState: (kind) => {
						void current.store
							.cycleState(kind)
							.then(() => view?.update())
							.catch(() => {});
					},
					close: () => close(null),
					requestRender: () => tui.requestRender(),
				});
				view = ghView;
				// GhView is a plain class, like WorktreeChangesView, with no terminal of
				// its own; the fullscreen wrapper wants a Component, so this is the
				// one-line adapter and the view stays Pi-agnostic.
				const component: Component = {
					render: (width: number) => ghView.render(width),
					handleInput: (data: string) => ghView.handleInput(data),
					invalidate() {},
				};
				// One coarse tick for the whole overlay: GitHub changes when somebody
				// else acts, and the store's TTL already drops a tick that is too soon.
				ticker = setInterval(() => {
					void current.store
						.refresh()
						.then(() => view?.update())
						.catch(() => {});
				}, GH_TTL_MS);
				ticker.unref();
				const interaction = createNativeFullscreenInteraction({ keyboardTarget: component, requestRender: () => tui.requestRender() });
				interaction.addChild(component);
				return interaction;
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } },
		);
	} finally {
		if (ticker) clearInterval(ticker);
		view?.dispose();
		view = undefined;
		overlayOpen = false;
	}
}

function openOverlay(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		if (ctx.hasUI) ctx.ui.notify(NO_TERMINAL, "warning");
		return;
	}
	// A second command while one is opening or open is a no-op: the pane already
	// on screen is that request, and a second store/ticker pair would leak.
	if (overlayOpen) return;
	const current = ensureRuntime(ctx);
	void showOverlay(current).catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"));
}

export default function gentleGh(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Browse this repository's pull requests and issues. Tab switches lists, o opens one in the browser, s switches the active list's state.",
		handler: async (_args, ctx) => openOverlay(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		// The section, its store and its `gh` calls are terminal-only: a headless
		// run or a subagent child has nothing to paint and nothing to ask for.
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		const current = ensureRuntime(ctx);
		mountSection(current, ctx);
		// The section is worth reading before anything is opened, so the first load
		// happens here; every later load is TTL-gated, so no turn can spam `gh`.
		void current.store.refresh().catch(() => {});
	});

	// A turn end is the natural coarse tick for a section nobody has opened: it is
	// where the agent's own pushes and comments show up, and the store's TTL drops
	// it whenever the last load is still fresh.
	pi.on("turn_end", (_event, ctx) => {
		if (!runtime || runtime.cwd !== ctx.cwd) return;
		void runtime.store.refresh().catch(() => {});
	});

	pi.on("session_shutdown", () => {
		runtime?.store.dispose();
		runtime = undefined;
	});
}
