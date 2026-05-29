import type { Browser } from "puppeteer-core";
import type { BrowserDefinition } from "../types.ts";

export interface LaunchRequest {
	executablePath: string;
	headless: boolean;
	userDataDir: string;
}

export interface LaunchResult {
	browser: Browser;
	// Tears down a launch-mode session: closes the browser and reaps any orphaned
	// process (notably Edge, which forks into sibling processes that survive
	// Browser.close). Called by the manager when a launch session stops.
	dispose(): Promise<void>;
}

export interface BrowserAdapter {
	readonly engine: BrowserDefinition["engine"];
	launch(definition: BrowserDefinition, request: LaunchRequest): Promise<LaunchResult>;
	attach(definition: BrowserDefinition, endpoint: string): Promise<Browser>;
}
