// Gentle Shell GitHub links: the one guarded route from the pane to a browser.
// The opener itself is shared (lib/star-prompt.ts spawns the platform opener
// with shell:false); this only decides which URLs may reach it.

import { openRepositoryInBrowser, type OpenRepositoryDeps, type OpenRepositoryResult } from "./star-prompt.ts";

/** An issue or pull request page on github.com, with a numeric id and no query. */
const GITHUB_ITEM = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/(?:pull|issues)\/[1-9][0-9]*$/;

export const NOT_GITHUB_ITEM = "only github.com pull request and issue pages can be opened";

export function isGithubItemUrl(url: string): boolean {
	return GITHUB_ITEM.test(url);
}

/** Opens one pane entry in the default browser; resolves instead of throwing when that is impossible. */
export function openGithubUrl(url: string, deps: OpenRepositoryDeps = {}): Promise<OpenRepositoryResult> {
	if (!isGithubItemUrl(url)) return Promise.resolve({ opened: false, error: NOT_GITHUB_ITEM });
	return openRepositoryInBrowser(url, deps);
}
