import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Provision a Firefox profile for automation, writing as little as possible into it.
 *
 * Puppeteer's own Firefox support calls `createProfile` from `@puppeteer/browsers`, which writes
 * about sixty preferences into `user.js`. That is right for a throwaway test profile and wrong for
 * pi-puppeteer, because of an asymmetry that is easy to miss:
 *
 * - Firefox applies its **own** list — `RecommendedPreferences.applyPreferences()`, run whenever
 *   `--remote-debugging-port` is passed — at startup, and clears every pref it set again at
 *   `xpcom-shutdown`. Nothing it does survives the session. That list already covers most of what
 *   puppeteer writes: `browser.shell.checkDefaultBrowser`, `browser.sessionstore.resume_from_crash`,
 *   `browser.startup.homepage_override.mstone`, `toolkit.startup.max_resumed_crashes`, and the rest.
 *   So writing them ourselves buys nothing.
 * - A `user.js` value, by contrast, is copied into `prefs.js` on every start and **stays in
 *   `prefs.js` after `user.js` is deleted**. One launch through `puppeteer.launch` would therefore
 *   permanently point a saved profile's `services.settings.server` at `http://dummy.test/`.
 *
 * A pi-puppeteer profile is meant to be a real Firefox profile that a person stays signed in to, so
 * the rule here is: write a pref only when Firefox does not already handle it at runtime, or when
 * Firefox handles it in a way that is actively wrong for a saved profile.
 *
 * The second case is exactly one thing, and it is the reason this file is not three lines long:
 * `RecommendedPreferences` sets `signon.rememberSignons` and `signon.autofillForms` to `false`. A
 * saved profile whose whole promise is "sign in once, stay signed in" would quietly never save a
 * password. `applyPreferences` skips any pref that already has a user value
 * (`if (!Services.prefs.prefHasUserValue(k))`), so writing them into `user.js` is the supported way
 * to win — and it is the only way, short of disabling Firefox's list wholesale and reimplementing
 * the safe half of it.
 */

export interface FirefoxProfileOptions {
	/** A throwaway profile keeps Firefox's automation hygiene: nothing it saves is meant to outlive it. */
	temporary: boolean;
}

export const PREF_BLOCK_BEGIN = "// pi-puppeteer:begin — managed automatically; edits inside this block are overwritten";
export const PREF_BLOCK_END = "// pi-puppeteer:end";

const USER_PREFS_FILE = "user.js";

/** One managed preference and the reason it is worth a permanent line in `prefs.js`. */
interface ManagedPref {
	key: string;
	value: boolean | number | string;
	why: string;
	/** Skipped for throwaway profiles, which have nothing worth persisting. */
	savedOnly?: boolean;
}

const MANAGED_PREFS: ManagedPref[] = [
	{
		key: "fission.webContentIsolationStrategy",
		value: 0,
		why: "BiDi cannot dispatch mouse events from the main frame into out-of-process iframes without it (Bugzilla 1773393). Firefox's own list does not set it.",
	},
	{
		key: "browser.aboutwelcome.enabled",
		value: false,
		why: "A brand-new profile otherwise opens about:welcome as its first tab, so the session's current tab is the onboarding page. Firefox covers the upgrade page, not first run.",
	},
	{
		key: "browser.startup.page",
		value: 0,
		why: "Makes the first tab deterministic. With session restore on, a saved profile reopens the last run's tabs and the session picks an arbitrary one as current.",
	},
	{
		key: "browser.startup.homepage",
		value: "about:blank",
		why: "Same, for a profile with a homepage set.",
	},
	{
		key: "signon.rememberSignons",
		value: true,
		savedOnly: true,
		why: "Firefox switches the password manager off by itself whenever a debugging port is passed. A saved profile exists to stay signed in, so it has to be switched back on.",
	},
	{
		key: "signon.autofillForms",
		value: true,
		savedOnly: true,
		why: "Same cause, same reason.",
	},
];

/** Render the managed block. Pure. */
export function renderFirefoxPrefs(options: FirefoxProfileOptions): string {
	const lines = [PREF_BLOCK_BEGIN];
	for (const pref of MANAGED_PREFS) {
		if (pref.savedOnly && options.temporary) continue;
		lines.push(`// ${pref.why}`);
		lines.push(`user_pref(${JSON.stringify(pref.key)}, ${JSON.stringify(pref.value)});`);
	}
	lines.push(PREF_BLOCK_END);
	return `${lines.join("\n")}\n`;
}

/**
 * Splice the managed block into an existing `user.js`, preserving every line outside the markers.
 *
 * `createProfile` clobbers the whole file, which would discard preferences a person set by hand in a
 * profile they own. Idempotent: merging the same block twice is a no-op, and a stale block is
 * replaced rather than duplicated.
 */
export function mergeFirefoxPrefs(existing: string, block: string): string {
	const begin = existing.indexOf(PREF_BLOCK_BEGIN);
	const end = existing.indexOf(PREF_BLOCK_END);

	if (begin === -1 || end === -1 || end < begin) {
		if (!existing.trim()) return block;
		return `${existing.replace(/\n*$/, "\n")}\n${block}`;
	}

	const before = existing.slice(0, begin);
	// Include the marker itself and the newline that follows it, so the splice leaves no blank gap.
	const after = existing.slice(end + PREF_BLOCK_END.length).replace(/^\n/, "");
	return `${before}${block}${after}`;
}

/**
 * Write the managed block into a profile's `user.js`, and only when it would change something.
 *
 * Leaving an unchanged file alone keeps its mtime, which `profile-store`'s `lastUsedAt` reads to
 * order the profile picker — reprovisioning on every launch would otherwise make every profile look
 * freshly used.
 */
export function ensureFirefoxPrefs(userDataDir: string, options: FirefoxProfileOptions): void {
	const path = join(userDataDir, USER_PREFS_FILE);
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	const merged = mergeFirefoxPrefs(existing, renderFirefoxPrefs(options));
	if (merged === existing) return;
	writeFileSync(path, merged, "utf8");
}
