import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import type { BrowserDefinition } from "../types.ts";
import type { BrowserAdapter, LaunchRequest, LaunchResult } from "./base.ts";

export class ChromiumAdapter implements BrowserAdapter {
	readonly engine = "chromium" as const;

	async launch(definition: BrowserDefinition, request: LaunchRequest): Promise<LaunchResult> {
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
		try {
			const browserURL = await waitForDevToolsEndpoint(request.userDataDir);
			browser = await puppeteer.connect({ browserURL, defaultViewport: null });
		} catch (error) {
			await reapProcesses(child, request.userDataDir);
			throw error;
		}

		return {
			browser,
			// Browser.close over a connected session does not reliably terminate Edge:
			// it forks sibling processes that get reparented and survive. Close
			// gracefully, then reap anything still bound to our dedicated profile dir.
			dispose: async () => {
				await browser.close().catch(() => undefined);
				await reapProcesses(child, request.userDataDir);
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

// Best-effort teardown: kill the process we spawned and any browser process whose
// command line references our unique user data dir (catches Edge's reparented forks).
async function reapProcesses(child: ChildProcess, userDataDir: string): Promise<void> {
	if (child.pid !== undefined) {
		try {
			child.kill();
		} catch {
			// already gone
		}
	}

	try {
		if (process.platform === "win32") {
			// Match on the user data dir via a substring test in PowerShell, passing the
			// path through an env var to sidestep quoting/escaping of backslashes.
			const script =
				"$udd=$env:PI_PUPPETEER_UDD; Get-CimInstance Win32_Process | " +
				"Where-Object { $_.CommandLine -and $_.CommandLine.Contains($udd) } | " +
				"ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
			await runToCompletion(
				spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
					stdio: "ignore",
					env: { ...process.env, PI_PUPPETEER_UDD: userDataDir },
				}),
			);
		} else {
			await runToCompletion(spawn("pkill", ["-f", userDataDir], { stdio: "ignore" }));
		}
	} catch {
		// process reaping is best-effort
	}
}

function runToCompletion(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		child.on("error", () => resolve());
		child.on("exit", () => resolve());
	});
}
