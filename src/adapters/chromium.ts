import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import type { BrowserDefinition } from "../types.ts";
import type { ProfileOwner } from "../profile-lock.ts";
import {
	clearDevToolsPort,
	clearOwner,
	inspectProfile,
	ownedByThisProcess,
	waitForProfileSettled,
	writeOwner,
} from "../profile-lock.ts";
import type { BrowserAdapter, LaunchRequest, LaunchResult } from "./base.ts";
import { CHROMIUM_PROFILE_ARG, reapProcesses } from "./reap.ts";

export class ChromiumAdapter implements BrowserAdapter {
	readonly engine = "chromium" as const;

	async launch(definition: BrowserDefinition, request: LaunchRequest): Promise<LaunchResult> {
		// Profiles are shared across projects, and Chromium allows only one browser process per
		// --user-data-dir: a second launch silently forwards its command line to the running instance
		// and exits. Detect that case up front and connect to the existing browser as a guest.
		let state = await inspectProfile(request.userDataDir);
		if (state.state === "starting") state = await waitForProfileSettled(request.userDataDir);

		// A Firefox-shaped profile under a Chromium browser key is a configuration mistake, not
		// something to spawn into: its user data dir holds a Firefox profile and a second browser on
		// top of it would corrupt both.
		if (state.state === "live" && state.engine === "firefox") {
			throw new Error(
				`Profile '${request.profile}' is being used by Firefox, so ${request.browserKey} cannot open it. ` +
					"Pass a different `profile`, or start this session with the firefox browser key.",
			);
		}

		if (state.state === "live") {
			const adoptedBrowser = await puppeteer.connect({ browserURL: state.browserURL, defaultViewport: null });
			return {
				browser: adoptedBrowser,
				adopted: true,
				ownerCwd: state.owner?.cwd,
				// We are a guest on someone else's browser: let go of it, never close or reap it.
				dispose: async () => {
					adoptedBrowser.disconnect();
				},
			};
		}

		// Claim the profile before spawning so a concurrent Pi process sees "starting" and waits
		// rather than racing us into a forwarded no-op.
		const owner: ProfileOwner = {
			pid: process.pid,
			browserURL: "",
			browserKey: request.browserKey,
			profile: request.profile,
			cwd: request.cwd,
			startedAt: Date.now(),
			host: hostname(),
			state: "starting",
		};
		writeOwner(request.userDataDir, owner);

		// We spawn the browser ourselves with a TCP debugging port and connect to it,
		// rather than using puppeteer.launch. puppeteer.launch watches the process it
		// spawns and reports a launch failure when a browser (notably Microsoft Edge)
		// relaunches/forks into a new process and the original exits with code 0 — the
		// window opens but Puppeteer loses control. A TCP debug endpoint survives that
		// handoff, so we connect to it instead of tracking a PID.
		const args = puppeteer
			.defaultArgs({ headless: request.headless, userDataDir: request.userDataDir, args: definition.launchArgs })
			.filter((arg) => arg !== "--remote-debugging-pipe");
		args.push("--remote-debugging-port=0");

		const child = spawn(request.executablePath, args, { stdio: "ignore", detached: false });
		child.unref();

		let browser: Browser;
		let browserURL: string;
		try {
			browserURL = await waitForDevToolsEndpoint(request.userDataDir);
			browser = await puppeteer.connect({ browserURL, defaultViewport: null });
		} catch (error) {
			// Sweep by user data dir only while we still hold the claim: a failed launch here must
			// never reap a browser that another Pi session owns on this shared profile.
			await reapProcesses(child, request.userDataDir, ownedByThisProcess(request.userDataDir), CHROMIUM_PROFILE_ARG);
			clearOwner(request.userDataDir);
			throw error;
		}

		writeOwner(request.userDataDir, { ...owner, state: "ready", browserURL });

		return {
			browser,
			adopted: false,
			// Browser.close over a connected session does not reliably terminate Edge:
			// it forks sibling processes that get reparented and survive. Close
			// gracefully, then reap anything still bound to our dedicated profile dir.
			dispose: async () => {
				await browser.close().catch(() => undefined);
				await reapProcesses(child, request.userDataDir, ownedByThisProcess(request.userDataDir), CHROMIUM_PROFILE_ARG);
				clearOwner(request.userDataDir);
				// Reaping force-kills, so Chromium never removes its own port file. Left behind, it
				// would advertise a port that some unrelated process could later bind.
				clearDevToolsPort(request.userDataDir);
			},
		};
	}

	async attach(_definition: BrowserDefinition, endpoint: string): Promise<Browser> {
		return puppeteer.connect(
			endpoint.startsWith("ws://") || endpoint.startsWith("wss://")
				? { browserWSEndpoint: endpoint, defaultViewport: null }
				: { browserURL: endpoint, defaultViewport: null },
		);
	}
}

// Chromium writes the chosen debugging port to DevToolsActivePort in the user data
// dir once the endpoint is ready. Poll for it, then confirm the endpoint responds.
async function waitForDevToolsEndpoint(userDataDir: string, timeoutMs = 30_000): Promise<string> {
	const portFile = join(userDataDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(portFile)) {
			const port = readFileSync(portFile, "utf8").trim().split("\n")[0]?.trim();
			if (port && /^\d+$/.test(port)) {
				try {
					const response = await fetch(`http://127.0.0.1:${port}/json/version`);
					if (response.ok) return `http://127.0.0.1:${port}`;
				} catch {
					// endpoint not ready yet; keep polling
				}
			}
		}
		await delay(100);
	}
	throw new Error(
		`Browser debugging endpoint did not become available within ${timeoutMs}ms. The browser may have failed to start.`,
	);
}
