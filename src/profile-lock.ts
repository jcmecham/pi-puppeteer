import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

export interface DiscoveredProfile {
	browserKey: string;
	profile: string;
	path: string;
	state: ProfileState["state"];
	/** Set when a browser is live or starting on this profile. */
	owner?: ProfileOwner;
	browserURL?: string;
	lastUsedAt?: number;
}

function directoryNames(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function lastUsedAt(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * List every profile under a profile root along with whether a browser is currently running on it.
 *
 * Profiles are shared across projects, so "is this one in use?" can only be answered by looking at
 * the profile itself. Probes run concurrently: each one may wait on a network timeout, and a root
 * can hold a dozen profiles.
 */
export async function discoverProfiles(profileRoot: string, browserKey?: string): Promise<DiscoveredProfile[]> {
	const browserKeys = browserKey ? [browserKey] : directoryNames(profileRoot);

	const candidates = browserKeys.flatMap((key) =>
		directoryNames(join(profileRoot, key)).map((profile) => ({ browserKey: key, profile, path: join(profileRoot, key, profile) })),
	);

	const discovered = await Promise.all(
		candidates.map(async (candidate): Promise<DiscoveredProfile> => {
			const state = await inspectProfile(candidate.path);
			return {
				...candidate,
				state: state.state,
				owner: state.state === "free" ? undefined : state.owner,
				browserURL: state.state === "live" ? state.browserURL : undefined,
				lastUsedAt: lastUsedAt(candidate.path),
			};
		}),
	);

	// Running profiles first, then most recently used, so the interesting entries lead.
	return discovered.sort((left, right) => {
		const liveDelta = Number(right.state !== "free") - Number(left.state !== "free");
		return liveDelta !== 0 ? liveDelta : (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0);
	});
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
