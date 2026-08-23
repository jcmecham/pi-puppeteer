import type { Browser } from "puppeteer-core";
import type { BrowserDefinition } from "../types.ts";

export interface LaunchRequest {
	executablePath: string;
	headless: boolean;
	userDataDir: string;
	// Identifying context for the profile ownership record, so a session that adopts a browser can
	// say which project started it.
	browserKey: string;
	profile: string;
	cwd: string;
	// Whether the profile is throwaway. Only Firefox reads it: a saved Firefox profile has to have
	// the password manager switched back on, which Firefox turns off by itself whenever a debugging
	// port is passed. See src/adapters/firefox-profile.ts.
	temporary: boolean;
}

export interface LaunchResult {
	browser: Browser;
	// Tears down a launch-mode session: closes the browser and reaps any orphaned
	// process (notably Edge, which forks into sibling processes that survive
	// Browser.close). Called by the manager when a launch session stops.
	dispose(): Promise<void>;
	// True when this session connected to a browser another process already had open on the shared
	// profile. Adopted browsers are disconnected on teardown, never closed.
	adopted: boolean;
	ownerCwd?: string;
}

export interface BrowserAdapter {
	readonly engine: BrowserDefinition["engine"];
	launch(definition: BrowserDefinition, request: LaunchRequest): Promise<LaunchResult>;
	attach(definition: BrowserDefinition, endpoint: string): Promise<Browser>;
}
