import { type ChildProcess, spawn } from "node:child_process";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import type { BrowserDefinition } from "../types.ts";
import type { ProfileOwner } from "../profile-lock.ts";
import {
	browserHoldsProfile,
	browserProvablyHoldsProfile,
	clearBidiEndpoint,
	clearOwner,
	inspectProfile,
	isProcessAlive,
	ownedByThisProcess,
	probeBidiStatus,
	readBidiEndpoint,
	waitForProfileSettled,
	writeOwner,
} from "../profile-lock.ts";
import type { BrowserAdapter, LaunchRequest, LaunchResult } from "./base.ts";
import { ensureFirefoxPrefs } from "./firefox-profile.ts";
import { browserProcessOnProfile, FIREFOX_PROFILE_ARG, reapProcesses } from "./reap.ts";

/**
 * Firefox over WebDriver BiDi.
 *
 * The shape follows ChromiumAdapter deliberately — inspect the profile, claim it, spawn the browser
 * ourselves, connect to a TCP endpoint, reap on teardown — because the session manager above both
 * adapters cannot tell them apart and should not have to. Three things genuinely differ:
 *
 * 1. **The endpoint.** Firefox 152 ships no CDP at all: there is no `/json/version` and no
 *    `DevToolsActivePort`. It writes `WebDriverBiDiServer.json` into the profile instead, and serves
 *    WebDriver BiDi over a WebSocket at `/session`.
 * 2. **One session per browser, ever** (Bug 1720707). Two Pi sessions cannot drive one Firefox the
 *    way two can drive one Chrome, so a contended profile is an error with an explanation rather
 *    than a shared window. Sequential handoff does work — see `dispose` below.
 * 3. **Profile preferences are ours to write**, which is why `puppeteer.launch` is avoided here. See
 *    the essay at the top of firefox-profile.ts; the short version is that `puppeteer.launch` would
 *    call `createProfile` and permanently rewrite sixty preferences in a profile the user owns.
 */
export class FirefoxAdapter implements BrowserAdapter {
	readonly engine = "firefox" as const;

	async launch(definition: BrowserDefinition, request: LaunchRequest): Promise<LaunchResult> {
		let state = await inspectProfile(request.userDataDir);
		if (state.state === "starting") state = await waitForProfileSettled(request.userDataDir);

		if (state.state === "live" && state.engine === "chromium") {
			throw new Error(
				`Profile '${request.profile}' is being used by a Chromium browser, so Firefox cannot open it. ` +
					"Pass a different `profile`.",
			);
		}

		if (state.state === "live") {
			if (!state.sessionAvailable) throw contendedSessionError(request.profile, state.owner);

			// Firefox hands its one session back when a client says `session.end`, so a browser some
			// earlier Pi process disconnected from cleanly is adoptable. The probe said so a moment ago;
			// re-label the race where someone claimed it in between.
			const adoptedBrowser = await puppeteer
				.connect({ browserWSEndpoint: `${state.browserWSEndpoint}/session`, protocol: "webDriverBiDi", defaultViewport: null })
				.catch((error: unknown) => {
					if (isSessionTakenError(error)) throw contendedSessionError(request.profile, state.owner);
					throw error;
				});

			return {
				browser: adoptedBrowser,
				adopted: true,
				ownerCwd: state.owner?.cwd,
				// `disconnect()` is load-bearing here, not merely polite. It sends `session.end`, and that
				// is the only thing that returns Firefox's single session to the pool — a dropped socket
				// leaves the session attached to nothing and the browser impossible to reconnect to.
				dispose: async () => {
					await adoptedBrowser.disconnect();
				},
			};
		}

		// A browser Pi did not launch leaves no endpoint to detect, only a held profile lock. Chromium
		// can afford to ignore that case — a second launch silently forwards its command line and exits
		// — but Firefox puts a modal "Firefox is already running" dialog on screen and our endpoint poll
		// then waits out its full timeout behind it. Refuse up front instead.
		if (await firefoxHoldsProfile(request.userDataDir)) {
			throw new Error(
				`A Firefox window is already open on profile '${request.profile}', outside Pi. Firefox allows one ` +
					"process per profile, so Pi cannot start a second one. Close that window, or pass a different `profile`.",
			);
		}

		ensureFirefoxPrefs(request.userDataDir, { temporary: request.temporary });

		// A force-killed Firefox never removes its own endpoint file. Left in place it would advertise a
		// dead port, and the poll below could accept it in the window before Firefox rewrites it.
		clearBidiEndpoint(request.userDataDir);

		// Claim the profile before spawning so a concurrent Pi process sees "starting" and waits.
		const owner: ProfileOwner = {
			pid: process.pid,
			browserURL: "",
			browserWSEndpoint: "",
			engine: "firefox",
			browserKey: request.browserKey,
			profile: request.profile,
			cwd: request.cwd,
			startedAt: Date.now(),
			host: hostname(),
			state: "starting",
		};
		writeOwner(request.userDataDir, owner);

		// `defaultArgs` supplies `--profile <dir>`, `--headless`, and the platform's own needs:
		// `--wait-for-browser` on Windows and `--foreground` on macOS. `--wait-for-browser` is wanted —
		// it keeps the process we spawned alive for the browser's lifetime, which is what makes
		// `child.kill()` mean anything. Unlike Chromium there is nothing to filter out, because Firefox
		// has no pipe transport to strip.
		const args = puppeteer.defaultArgs({
			browser: "firefox",
			headless: request.headless,
			userDataDir: request.userDataDir,
			args: definition.launchArgs,
		});
		args.push("--remote-debugging-port=0");

		const child = spawn(request.executablePath, args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
		const stderr = captureStderr(child);
		child.unref();

		let browser: Browser;
		let origin: string;
		try {
			origin = await waitForBidiEndpoint(request.userDataDir, stderr);
			browser = await puppeteer.connect({
				browserWSEndpoint: `${origin}/session`,
				protocol: "webDriverBiDi",
				defaultViewport: null,
			});
		} catch (error) {
			// Sweep by profile only while we still hold the claim: a failed launch must never reap a
			// browser another Pi session owns on this shared profile.
			await reapProcesses(child, request.userDataDir, ownedByThisProcess(request.userDataDir), FIREFOX_PROFILE_ARG);
			clearOwner(request.userDataDir);
			clearBidiEndpoint(request.userDataDir);
			throw withStderr(error, stderr());
		}

		writeOwner(request.userDataDir, { ...owner, state: "ready", browserWSEndpoint: origin });

		return {
			browser,
			adopted: false,
			dispose: async () => {
				await browser.close().catch(() => undefined);
				await reapProcesses(child, request.userDataDir, ownedByThisProcess(request.userDataDir), FIREFOX_PROFILE_ARG);
				clearOwner(request.userDataDir);
				// Reaping force-kills, so Firefox never removes its own endpoint file.
				clearBidiEndpoint(request.userDataDir);
			},
		};
	}

	async attach(_definition: BrowserDefinition, endpoint: string): Promise<Browser> {
		const target = normalizeFirefoxEndpoint(endpoint);
		try {
			return await puppeteer.connect({ browserWSEndpoint: target, protocol: "webDriverBiDi", defaultViewport: null });
		} catch (error) {
			throw new Error(explainAttachFailure(target, error), { cause: error });
		}
	}
}

/**
 * Is a Firefox outside Pi holding this profile?
 *
 * Two questions, cheapest first. A lock symlink naming a live process — or on Windows a marker the OS
 * will not hand over — settles it for nothing. What is left is the case only POSIX has: a
 * `.parentlock` that proves nothing either way, because Firefox locks it with fcntl and never removes
 * it, so every profile that has ever run Firefox looks exactly like one running Firefox now. Reading
 * that as "held" is what would refuse a launch on any Linux or macOS profile after its first run.
 *
 * Only that genuinely undecidable case reaches the process list, and it costs one `pgrep` on a path
 * that is about to spawn a browser.
 */
async function firefoxHoldsProfile(userDataDir: string): Promise<boolean> {
	if (browserProvablyHoldsProfile(userDataDir)) return true;
	if (!browserHoldsProfile(userDataDir)) return false;
	return await browserProcessOnProfile(userDataDir, FIREFOX_PROFILE_ARG);
}

/**
 * Normalize whatever endpoint spelling reached us into the one Firefox actually serves.
 *
 * `--remote-debugging-port` reads like an HTTP thing, every other browser in the config uses an
 * `http://` attach URL, and Firefox's remote agent genuinely is an HTTP server that upgrades at
 * `/session`. Accepting both spellings costs a few lines and removes the likeliest user error.
 */
export function normalizeFirefoxEndpoint(endpoint: string): string {
	let url: URL;
	try {
		url = new URL(endpoint.trim());
	} catch {
		throw new Error(
			`'${endpoint}' is not a Firefox debugging endpoint. Use ws://host:port/session, or the http://host:port ` +
				"form of the same address.",
		);
	}

	const scheme = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" }[url.protocol];
	if (!scheme) {
		throw new Error(
			`'${endpoint}' is not a Firefox debugging endpoint. Use ws://host:port/session, or the http://host:port ` +
				"form of the same address.",
		);
	}
	url.protocol = scheme;

	// A session-scoped path is left exactly as given. Rewriting it would silently connect somewhere
	// other than where the caller pointed; `explainAttachFailure` says why it cannot work instead.
	if (url.pathname !== "/" && url.pathname !== "") return url.toString().replace(/\/$/, "");
	return `${url.origin}/session`;
}

/** Wait for Firefox to advertise its WebSocket endpoint, and confirm something answers on it. */
async function waitForBidiEndpoint(userDataDir: string, stderr: () => string, timeoutMs = 30_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const endpoint = readBidiEndpoint(userDataDir);
		if (endpoint && (await probeBidiStatus(endpoint.url)).reachable) return endpoint.url;
		await delay(100);
	}

	// The file is primary because it is the only signal another Pi process can read. Firefox writes it
	// inside a try/catch and only warns on failure, so the stderr line it prints first is a genuine
	// fallback rather than belt-and-braces.
	const logged = /^WebDriver BiDi listening on (ws:\/\/\S+)$/m.exec(stderr());
	if (logged?.[1] && (await probeBidiStatus(logged[1])).reachable) return logged[1];

	// The guard before the spawn catches a foreign Firefox on this profile in every case it can see
	// one. If it could not — no `pgrep` on the box, a browser started some way that does not name the
	// directory — this timeout is where that lands, behind a modal dialog nothing here can read.
	throw new Error(
		`Firefox did not report a WebDriver BiDi endpoint within ${timeoutMs}ms. The browser may have failed to ` +
			"start, or a Firefox already open on this profile may be holding the launch behind a dialog.",
	);
}

/**
 * Retain the tail of a child's stderr, and keep the pipe drained.
 *
 * An unread pipe fills and then blocks the child, so this has to consume the stream whether or not
 * anyone ever reads it. Worth the few lines: when a launch fails, Firefox's own last words are the
 * only explanation available, and the Chromium adapter has none today.
 */
function captureStderr(child: ChildProcess, limit = 8_192): () => string {
	let buffer = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		buffer = (buffer + chunk.toString("utf8")).slice(-limit);
	});
	child.stderr?.on("error", () => undefined);
	return () => buffer;
}

function withStderr(error: unknown, stderr: string): Error {
	const tail = stderr.trim();
	if (!(error instanceof Error) || !tail) return error instanceof Error ? error : new Error(String(error));
	return new Error(`${error.message}\n\nFirefox said:\n${tail}`, { cause: error });
}

/** Firefox's own wording when a second WebDriver session is requested. */
function isSessionTakenError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Maximum number of active sessions");
}

function contendedSessionError(profile: string, owner?: ProfileOwner): Error {
	// A live owner record means another Pi process is driving it. No live owner means the process that
	// opened the session is gone without saying `session.end`, and Firefox cannot hand that session
	// back to anyone — the window has to be closed.
	if (owner && isProcessAlive(owner.pid)) {
		return new Error(
			`Firefox is already being driven by Pi in ${owner.cwd} on profile '${profile}'. Firefox allows one ` +
				"automation session per browser, so this one cannot be shared the way Chrome can. Close that session, " +
				"or pass a different `profile` to get a separate window.",
		);
	}
	return new Error(
		`Firefox is running on profile '${profile}' but its automation session was left open by a Pi process that ` +
			"did not shut down cleanly. Firefox cannot hand that session back. Close the Firefox window and try again.",
	);
}

function explainAttachFailure(target: string, error: unknown): string {
	if (isSessionTakenError(error)) {
		return (
			`Firefox at ${target} is already running an automation session. Firefox allows only one per browser, ` +
			"so it cannot be attached to until whatever is driving it disconnects."
		);
	}
	if (!target.endsWith("/session")) {
		return (
			`${target} names an existing WebDriver session. Puppeteer can only create new sessions, so it cannot ` +
			"reattach to one. Use ws://host:port/session instead."
		);
	}
	return (
		`Nothing is listening at ${target}. Firefox only exposes an automation endpoint when it was started with ` +
		"--remote-debugging-port, for example: firefox --remote-debugging-port=9222"
	);
}
