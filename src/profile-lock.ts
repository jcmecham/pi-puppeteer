import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { BrowserEngine } from "./types.ts";

// Chromium can only hold one browser process per --user-data-dir. Profiles used to be project-local,
// so that was never contended; now that they are shared across projects, two Pi sessions can want the
// same profile at once. These helpers let the second session recognise the first and connect to its
// browser as a guest instead of spawning a process that silently forwards its command line and exits.

const OWNER_FILE = ".pi-puppeteer-owner.json";
const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
// Firefox's answer to DevToolsActivePort. The remote agent writes it once the WebSocket server is
// listening and removes it on a clean shutdown, so — exactly like the Chromium file — its presence
// is a hint and never proof.
const BIDI_SERVER_FILE = "WebDriverBiDiServer.json";
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
	/**
	 * Optional so records written before Firefox support still parse. Absent means chromium, which is
	 * correct: every record that predates this field was written by the Chromium adapter.
	 */
	engine?: BrowserEngine;
	/** Firefox's endpoint, `ws://host:port`. Chromium records carry `browserURL` instead. */
	browserWSEndpoint?: string;
}

/**
 * The live variants are discriminated by engine rather than sharing one optional endpoint field, so
 * the compiler refuses to let a `ws://` URL reach `puppeteer.connect({ browserURL })`. Every reader
 * of an endpoint has to say which protocol it expects.
 */
export type ProfileState =
	| { state: "free" }
	| { state: "starting"; owner: ProfileOwner }
	| { state: "live"; engine: "chromium"; browserURL: string; owner?: ProfileOwner }
	| {
			state: "live";
			engine: "firefox";
			browserWSEndpoint: string;
			/** False when a WebDriver session is already attached, so this browser cannot be adopted. */
			sessionAvailable: boolean;
			owner?: ProfileOwner;
	  };

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

export interface BidiEndpoint {
	host: string;
	port: number;
	/** `ws://host:port`, with no path. The WebDriver BiDi handler lives at `/session`. */
	url: string;
}

/**
 * Read the WebSocket endpoint Firefox advertises inside a profile directory.
 *
 * This is `readDevToolsUrl` for the other engine. Firefox 152 serves no HTTP debugging endpoint at
 * all — CDP was removed, so there is no `/json/version` to ask — and this file is the only way one
 * Pi process can learn about a browser another one launched.
 */
export function readBidiEndpoint(userDataDir: string): BidiEndpoint | undefined {
	try {
		const raw = JSON.parse(readFileSync(join(userDataDir, BIDI_SERVER_FILE), "utf8")) as {
			ws_host?: unknown;
			ws_port?: unknown;
		};
		const host = typeof raw.ws_host === "string" ? raw.ws_host : undefined;
		const port = typeof raw.ws_port === "number" ? raw.ws_port : undefined;
		if (!host || !port || !Number.isInteger(port) || port <= 0) return undefined;
		return { host, port, url: `ws://${host}:${port}` };
	} catch {
		return undefined;
	}
}

export function clearBidiEndpoint(userDataDir: string): void {
	try {
		rmSync(join(userDataDir, BIDI_SERVER_FILE), { force: true });
	} catch {
		// best effort
	}
}

export interface BidiStatus {
	/** Something answered `session.status` on this endpoint. */
	reachable: boolean;
	/** No WebDriver session is attached yet, so a new one can be created. */
	sessionAvailable: boolean;
}

/**
 * Interpret a `session.status` reply. Pure, so it can be asserted without opening a socket.
 *
 * `ready: false` does not mean the browser is unhealthy — it means a session is already attached.
 * Firefox permits exactly one per browser process (Bug 1720707) and says so in `message`.
 */
export function parseBidiStatus(payload: unknown): BidiStatus | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const result = (payload as { result?: unknown }).result;
	if (typeof result !== "object" || result === null) return undefined;
	const ready = (result as { ready?: unknown }).ready;
	if (typeof ready !== "boolean") return undefined;
	return { reachable: true, sessionAvailable: ready };
}

/**
 * Ask a Firefox remote agent whether it is alive and whether its one session is free.
 *
 * The Chromium path confirms a port file with a real `/json/version` request for a reason — Windows
 * recycles ports, so a file naming a port proves nothing. This is the same two-step, and it answers
 * the extra question Firefox's single-session limit forces on us. Puppeteer opens a connection and
 * sends this exact command as its first act, so the shape is the supported one.
 *
 * Only call this when `readBidiEndpoint` or an owner record produced the origin: each probe leaves
 * one inert entry in Firefox's sessionless-connection set, which is harmless but not free.
 */
export async function probeBidiStatus(origin: string, timeoutMs = 1500): Promise<BidiStatus> {
	const unreachable: BidiStatus = { reachable: false, sessionAvailable: false };
	let socket: WebSocket | undefined;
	try {
		return await new Promise<BidiStatus>((resolve) => {
			const finish = (status: BidiStatus) => {
				clearTimeout(timer);
				resolve(status);
			};
			const timer = setTimeout(() => finish(unreachable), timeoutMs);

			socket = new WebSocket(`${origin}/session`);
			socket.onopen = () => socket?.send(JSON.stringify({ id: 1, method: "session.status", params: {} }));
			socket.onerror = () => finish(unreachable);
			socket.onclose = () => finish(unreachable);
			socket.onmessage = (event) => {
				try {
					finish(parseBidiStatus(JSON.parse(String(event.data))) ?? unreachable);
				} catch {
					finish(unreachable);
				}
			};
		});
	} catch {
		// A malformed origin never reaches the constructor's happy path.
		return unreachable;
	} finally {
		try {
			socket?.close();
		} catch {
			// best effort
		}
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
		} else if ((owner.engine ?? "chromium") === "chromium") {
			if (owner.browserURL && (await probeEndpoint(owner.browserURL))) {
				return { state: "live", engine: "chromium", browserURL: owner.browserURL, owner };
			}
		} else if (owner.browserWSEndpoint) {
			const status = await probeBidiStatus(owner.browserWSEndpoint);
			if (status.reachable) {
				return {
					state: "live",
					engine: "firefox",
					browserWSEndpoint: owner.browserWSEndpoint,
					sessionAvailable: status.sessionAvailable,
					owner,
				};
			}
		}
	}
	if (owner) clearOwner(userDataDir, owner.pid);

	// A browser started before this version, or by something other than Pi, leaves no claim but does
	// leave a port file. Trust it only as far as a live response.
	const browserURL = readDevToolsUrl(userDataDir);
	if (browserURL && (await probeEndpoint(browserURL))) return { state: "live", engine: "chromium", browserURL };

	// The same courtesy for Firefox. This is what stops the throwaway sweep deleting a profile out
	// from under a running browser whose owner record was lost to a crash: without it every live
	// Firefox profile answered "free", because the only liveness signal Pi had was a DevTools port
	// Firefox does not write.
	const bidi = readBidiEndpoint(userDataDir);
	if (bidi) {
		const status = await probeBidiStatus(bidi.url);
		if (status.reachable) {
			return { state: "live", engine: "firefox", browserWSEndpoint: bidi.url, sessionAvailable: status.sessionAvailable };
		}
	}

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
 *
 * Resolving "cannot tell" as held is right for that caller and wrong for one that is deciding whether
 * to *start* a browser — see `browserProvablyHoldsProfile`.
 */
export function browserHoldsProfile(profileDir: string): boolean {
	return LOCK_MARKERS.some((marker) => markerState(join(profileDir, marker)) !== "free");
}

/**
 * The same question, answered only where the answer can be proven.
 *
 * The asymmetry above cuts the other way for a launch. Refusing to rename a profile costs a retry;
 * refusing to launch one prints "close that window" about a window that does not exist, and leaves
 * the user nothing to act on. Firefox turns that from occasional into permanent: `.parentlock` is a
 * plain file it locks with fcntl and deliberately never unlinks (`// Don't remove it`, in
 * `nsProfileLock::Unlock`), so on POSIX every profile that has ever run Firefox is unprovable from
 * then on — and a cautious launch gate would refuse it forever after the first run.
 *
 * So only real evidence counts here: a lock symlink naming a process that is still alive, or on
 * Windows a marker the OS refuses to hand over. "Cannot tell" is false, and a caller that needs the
 * unprovable case settled asks the process list instead — see `browserProcessOnProfile`.
 */
export function browserProvablyHoldsProfile(profileDir: string): boolean {
	return LOCK_MARKERS.some((marker) => markerState(join(profileDir, marker)) === "held");
}

/** What one marker proves: a browser holds the profile, none does, or the marker cannot say. */
type MarkerState = "held" | "free" | "unknown";

function markerState(markerPath: string): MarkerState {
	let isSymbolicLink: boolean;
	try {
		isSymbolicLink = lstatSync(markerPath).isSymbolicLink();
	} catch {
		return "free"; // No marker at all: nothing has claimed this profile.
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
		if (pid === undefined) return process.platform === "win32" ? "free" : "unknown";
		return isProcessAlive(pid) ? "held" : "free";
	}

	// A POSIX lock file is held with fcntl, which an ordinary open cannot detect.
	if (process.platform !== "win32") return "unknown";

	try {
		closeSync(openSync(markerPath, "r+"));
		return "free";
	} catch (error) {
		// ENOENT means it vanished between the stat and the open, so nothing is holding it.
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "held";
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
