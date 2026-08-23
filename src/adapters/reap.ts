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

export function runToCompletion(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		child.on("error", () => resolve());
		child.on("exit", () => resolve());
	});
}
