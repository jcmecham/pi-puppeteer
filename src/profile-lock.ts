import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// Chromium can only hold one browser process per --user-data-dir. Profiles used to be project-local,
// so that was never contended; now that they are shared across projects, two Pi sessions can want the
// same profile at once. These helpers let the second session recognise the first and connect to its
// browser as a guest instead of spawning a process that silently forwards its command line and exits.

const OWNER_FILE = ".pi-puppeteer-owner.json";
const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
/** How long a "starting" claim is honoured before it is treated as abandoned. */
const STARTUP_GRACE_MS = 60_000;

export interface ProfileOwner {
	pid: number;
	browserURL: string;
	browserKey: string;
	profile: string;
	cwd: string;
	startedAt: number;
	host: string;
	state: "starting" | "ready";
}

export type ProfileState =
	| { state: "free" }
	| { state: "starting"; owner: ProfileOwner }
	| { state: "live"; browserURL: string; owner?: ProfileOwner };

export function ownerPath(userDataDir: string): string {
	return join(userDataDir, OWNER_FILE);
}

export function readOwner(userDataDir: string): ProfileOwner | undefined {
	try {
		const owner = JSON.parse(readFileSync(ownerPath(userDataDir), "utf8")) as ProfileOwner;
		return typeof owner?.pid === "number" ? owner : undefined;
	} catch {
		return undefined;
	}
}

export function writeOwner(userDataDir: string, owner: ProfileOwner): void {
	try {
		writeFileSync(ownerPath(userDataDir), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
	} catch {
		// Losing the claim only costs us adoption; it must never fail a launch.
	}
}

/** Remove the claim only when it is ours, so a slow teardown cannot delete a newer owner's record. */
export function clearOwner(userDataDir: string, expectPid = process.pid): void {
	const owner = readOwner(userDataDir);
	if (owner && owner.pid !== expectPid) return;
	try {
		rmSync(ownerPath(userDataDir), { force: true });
	} catch {
		// best effort
	}
}

export function ownedByThisProcess(userDataDir: string): boolean {
	return readOwner(userDataDir)?.pid === process.pid;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function probeEndpoint(browserURL: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const response = await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
		return response.ok;
	} catch {
		return false;
	}
}

function readDevToolsUrl(userDataDir: string): string | undefined {
	try {
		const port = readFileSync(join(userDataDir, DEVTOOLS_PORT_FILE), "utf8").trim().split("\n")[0]?.trim();
		return port && /^\d+$/.test(port) ? `http://127.0.0.1:${port}` : undefined;
	} catch {
		return undefined;
	}
}

export function clearDevToolsPort(userDataDir: string): void {
	try {
		rmSync(join(userDataDir, DEVTOOLS_PORT_FILE), { force: true });
	} catch {
		// best effort
	}
}

/**
 * Decide whether a profile is free, being claimed, or already serving a live browser.
 *
 * Every "yes, it is alive" answer is confirmed by an actual request to the DevTools endpoint. A PID
 * alone is not enough: Windows recycles PIDs aggressively, so a stale claim can name a live but
 * unrelated process.
 */
export async function inspectProfile(userDataDir: string): Promise<ProfileState> {
	if (!existsSync(userDataDir)) return { state: "free" };

	const owner = readOwner(userDataDir);
	if (owner && owner.host === hostname() && isProcessAlive(owner.pid)) {
		if (owner.state === "starting") {
			if (Date.now() - owner.startedAt < STARTUP_GRACE_MS) return { state: "starting", owner };
		} else if (owner.browserURL && (await probeEndpoint(owner.browserURL))) {
			return { state: "live", browserURL: owner.browserURL, owner };
		}
	}
	if (owner) clearOwner(userDataDir, owner.pid);

	// A browser started before this version, or by something other than Pi, leaves no claim but does
	// leave a port file. Trust it only as far as a live response.
	const browserURL = readDevToolsUrl(userDataDir);
	if (browserURL && (await probeEndpoint(browserURL))) return { state: "live", browserURL };

	return { state: "free" };
}

/** Files a browser leaves in a profile directory while it holds it. */
const LOCK_MARKERS = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lock", ".parentlock", "parent.lock"];

/**
 * Decide whether a browser currently holds a profile directory, from its lock files alone.
 *
 * Existence is not the answer, which is the trap this replaced. Firefox creates `parent.lock` once and
 * never deletes it — it holds the file open exclusively while running — so testing for the file called
 * every Firefox profile that had ever run "in use", permanently and with no action a user could take
 * to clear it. Chromium's SingletonLock survives a crash to the same effect.
 *
 * What "held" means differs by platform, and so does the cost of guessing wrong:
 *
 * - Windows refuses to rename a directory a browser has open, so there the rename is the real guard
 *   and this check only has to avoid crying wolf. Asking the OS to open the marker answers it exactly.
 * - POSIX renames succeed no matter who holds the directory, so here this check is the only guard and
 *   a wrong "free" silently breaks a running browser. A pid read out of a lock symlink settles most
 *   cases; anything still unproven counts as in use.
 *
 * This answers a narrower question than `inspectProfile`, which needs a live debugging endpoint. Lock
 * files are all a browser Pi did not launch leaves behind, and migration has to cope with those.
 */
export function browserHoldsProfile(profileDir: string): boolean {
	return LOCK_MARKERS.some((marker) => markerIsHeld(join(profileDir, marker)));
}

function markerIsHeld(markerPath: string): boolean {
	let isSymbolicLink: boolean;
	try {
		isSymbolicLink = lstatSync(markerPath).isSymbolicLink();
	} catch {
		return false; // No marker at all: nothing has claimed this profile.
	}

	// Chromium points SingletonLock at "<hostname>-<pid>" and Firefox points lock at "<ip>:+<pid>".
	// Both outlive a crash, so the pid inside them is what decides.
	if (isSymbolicLink) {
		let pid: number | undefined;
		try {
			pid = pidFromLockTarget(readlinkSync(markerPath));
		} catch {
			pid = undefined;
		}
		return pid === undefined ? process.platform !== "win32" : isProcessAlive(pid);
	}

	// A POSIX lock file is held with fcntl, which an ordinary open cannot detect. Unprovable means in
	// use, because the rename that follows would not fail on our behalf.
	if (process.platform !== "win32") return true;

	try {
		closeSync(openSync(markerPath, "r+"));
		return false;
	} catch (error) {
		// ENOENT means it vanished between the stat and the open, so nothing is holding it.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

function pidFromLockTarget(target: string): number | undefined {
	const match = /[-+](\d+)$/.exec(target);
	const pid = match ? Number(match[1]) : Number.NaN;
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Wait out another process's in-flight launch rather than racing it into a forwarded no-op. */
export async function waitForProfileSettled(userDataDir: string, timeoutMs = 30_000): Promise<ProfileState> {
	const deadline = Date.now() + timeoutMs;
	let state = await inspectProfile(userDataDir);
	while (state.state === "starting" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		state = await inspectProfile(userDataDir);
	}
	return state;
}
