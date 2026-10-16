import { type ChildProcess, spawn } from "node:child_process";

/**
 * How a browser family spells its profile directory on the command line.
 *
 * Both matchers must anchor the end of the argument. A prefix test would let
 * `.../profiles/chrome/default` reap `.../profiles/chrome/default-2` as well.
 */
export interface ProfileArgMatcher {
	/** A PowerShell expression producing the regex, with the directory available as `$udd`. */
	powershell: string;
	/** The `pkill -f` pattern for a given directory. */
	posix(userDataDir: string): string;
}

const escapePosix = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Chromium joins the directory to the flag: `--user-data-dir=C:\path`. */
export const CHROMIUM_PROFILE_ARG: ProfileArgMatcher = {
	powershell: `[regex]::Escape('--user-data-dir=' + $udd) + '(?:"|\\s|$)'`,
	posix: (userDataDir) => `--user-data-dir=${escapePosix(userDataDir)}($|[ "])`,
};

/**
 * Firefox passes the directory as a separate argv entry: `--profile C:\path`. It also accepts the
 * single-dash spelling, and Windows quotes the path when it contains spaces — which a profile root
 * under a user's home directory routinely does.
 */
export const FIREFOX_PROFILE_ARG: ProfileArgMatcher = {
	powershell: `'(?:--|-)profile\\s+"?' + [regex]::Escape($udd) + '(?:"|\\s|$)'`,
	posix: (userDataDir) => `(--|-)profile +"?${escapePosix(userDataDir)}($|[ "])`,
};

/**
 * Best-effort teardown shared by both adapters: kill the process we spawned, then kill any browser
 * process still bound to the same profile directory.
 *
 * Closing a browser over its debugging connection is not reliably enough. Edge forks sibling
 * processes that get reparented and survive `Browser.close`, and a force-killed Firefox can leave a
 * content process holding the profile. Sweeping by the profile argument catches both.
 *
 * `sweepByProfile` must be false unless this process owns the profile claim. Profiles are shared
 * across projects, so a blind sweep would kill a browser another Pi session is driving.
 */
export async function reapProcesses(
	child: ChildProcess,
	userDataDir: string,
	sweepByProfile: boolean,
	matcher: ProfileArgMatcher,
): Promise<void> {
	if (child.pid !== undefined) {
		try {
			child.kill();
		} catch {
			// already gone
		}
	}

	if (!sweepByProfile) return;

	try {
		if (process.platform === "win32") {
			// The path travels via an env var to sidestep quoting and backslash escaping in the script.
			const script =
				"$udd=$env:PI_PUPPETEER_UDD; " +
				`$pattern=${matcher.powershell}; ` +
				"Get-CimInstance Win32_Process | " +
				"Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } | " +
				"ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
			await runToCompletion(
				spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
					stdio: "ignore",
					env: { ...process.env, PI_PUPPETEER_UDD: userDataDir },
				}),
			);
		} else {
			await runToCompletion(spawn("pkill", ["-f", "--", matcher.posix(userDataDir)], { stdio: "ignore" }));
		}
	} catch {
		// process reaping is best-effort
	}
}

/**
 * Is a browser process bound to this profile directory right now?
 *
 * The same evidence `reapProcesses` acts on, asked as a question instead of an order. Lock files
 * answer this cheaply but not everywhere: a Firefox holding a profile on macOS leaves only an fcntl
 * lock on `.parentlock`, which no ordinary open can detect and which outlives the browser anyway.
 * The process list has no such blind spot.
 *
 * Best-effort in the safe direction — a missing `pgrep`, an unavailable PowerShell, anything at all
 * going wrong answers false. A launch that proceeds and then fails carries the browser's own words;
 * a launch blocked by a tool that could not run carries nothing.
 */
export async function browserProcessOnProfile(userDataDir: string, matcher: ProfileArgMatcher): Promise<boolean> {
	try {
		if (process.platform === "win32") {
			// The path travels via an env var for the same reason it does above, and because the script's
			// own command line would otherwise match the pattern it is searching for.
			const script =
				"$udd=$env:PI_PUPPETEER_UDD; " +
				`$pattern=${matcher.powershell}; ` +
				"$hit = Get-CimInstance Win32_Process | " +
				"Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } | " +
				"Select-Object -First 1; " +
				"if ($hit) { exit 0 } else { exit 1 }";
			return await exitedZero(
				spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
					stdio: "ignore",
					env: { ...process.env, PI_PUPPETEER_UDD: userDataDir },
				}),
			);
		}
		// `pgrep -f` exits 0 when something matched and 1 when nothing did, and never matches itself.
		return await exitedZero(spawn("pgrep", ["-f", "--", matcher.posix(userDataDir)], { stdio: "ignore" }));
	} catch {
		return false;
	}
}

export function runToCompletion(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		child.on("error", () => resolve());
		child.on("exit", () => resolve());
	});
}

/** True only when the child exited 0. A spawn error — no such binary — is false, not a throw. */
function exitedZero(child: ChildProcess): Promise<boolean> {
	return new Promise((resolve) => {
		child.on("error", () => resolve(false));
		child.on("exit", (code) => resolve(code === 0));
	});
}
