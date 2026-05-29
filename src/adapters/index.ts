import type { BrowserDefinition } from "../types.ts";
import type { BrowserAdapter } from "./base.ts";
import { ChromiumAdapter } from "./chromium.ts";
import { FirefoxAdapter } from "./firefox.ts";

const adapters: Record<BrowserDefinition["engine"], BrowserAdapter> = {
	chromium: new ChromiumAdapter(),
	firefox: new FirefoxAdapter(),
};

export function getAdapter(engine: BrowserDefinition["engine"]): BrowserAdapter {
	return adapters[engine];
}
