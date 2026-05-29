import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import type { BrowserDefinition } from "../types.ts";
import type { BrowserAdapter, LaunchRequest, LaunchResult } from "./base.ts";

export class FirefoxAdapter implements BrowserAdapter {
	readonly engine = "firefox" as const;

	async launch(definition: BrowserDefinition, request: LaunchRequest): Promise<LaunchResult> {
		const browser = await puppeteer.launch({
			executablePath: request.executablePath,
			browser: "firefox",
			protocol: "webDriverBiDi",
			headless: request.headless,
			userDataDir: request.userDataDir,
			defaultViewport: null,
			args: definition.launchArgs,
		});
		return { browser, dispose: () => browser.close() };
	}

	async attach(_definition: BrowserDefinition, _endpoint: string): Promise<Browser> {
		throw new Error(
			"Firefox attach is not implemented yet. The architecture reserves this path for a future WebDriver BiDi attach flow.",
		);
	}
}
