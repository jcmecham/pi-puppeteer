import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { BrowserManager } from "./manager.ts";
import type { BrowserToolInput, RawExtensionConfig, ResolvedConfig } from "./types.ts";

async function writeProjectDefaultBrowser(config: ResolvedConfig, browserKey: string): Promise<void> {
	const projectConfigPath = config.configPaths.project;
	const existing: RawExtensionConfig = existsSync(projectConfigPath)
		? (JSON.parse(readFileSync(projectConfigPath, "utf8")) as RawExtensionConfig)
		: {};

	existing.defaultBrowser = browserKey;
	await mkdir(dirname(projectConfigPath), { recursive: true });
	await writeFile(projectConfigPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

function browserOptionLabel(key: string, definition: ResolvedConfig["browsers"][string], currentSetting: string): string {
	const current = key === currentSetting ? " (current)" : "";
	return `${definition.displayName} [${key}] — ${definition.engine}${current}`;
}

function systemOptionLabel(config: ResolvedConfig): string {
	const current = config.defaultBrowserSetting === "system" ? " (current)" : "";
	return `System [${config.systemDefaultBrowser}] — OS default${current}`;
}

const BrowserToolSchema = Type.Object({
	action: StringEnum(
		[
			"list_browsers",
			"start",
			"attach",
			"sessions",
			"stop",
			"tabs",
			"new_tab",
			"select_tab",
			"close_tab",
			"navigate",
			"click",
			"type",
			"press",
			"scroll",
			"wait_for",
			"extract_text",
			"inspect",
			"screenshot",
			"record_start",
			"record_stop",
		] as const,
	),
	browserKey: Type.Optional(Type.String({ description: "Configured browser key, like chrome or edge; use system for the detected OS default browser" })),
	sessionId: Type.Optional(Type.String({ description: "Browser session ID, like session-1" })),
	tabId: Type.Optional(Type.String({ description: "Tab ID, like tab-1" })),
	profile: Type.Optional(Type.String({ description: "Named profile for launch mode" })),
	url: Type.Optional(Type.String({ description: "URL for start, new_tab, or navigate" })),
	selector: Type.Optional(Type.String({ description: "CSS selector for page actions" })),
	text: Type.Optional(Type.String({ description: "Text content for type actions" })),
	key: Type.Optional(Type.String({ description: "Keyboard key for press" })),
	path: Type.Optional(Type.String({ description: "Output path for screenshots or recordings" })),
	endpoint: Type.Optional(Type.String({ description: "Attach endpoint: browserURL or browserWSEndpoint" })),
	headless: Type.Optional(Type.Boolean({ description: "Override launch headless mode" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Timeout override in milliseconds" })),
	waitUntil: Type.Optional(StringEnum(["load", "domcontentloaded", "networkidle0", "networkidle2"] as const)),
	replace: Type.Optional(Type.Boolean({ description: "When typing, replace existing field value first (default true)" })),
	fullPage: Type.Optional(Type.Boolean({ description: "Capture a full-page screenshot (default true)" })),
	scrollX: Type.Optional(Type.Number({ description: "Horizontal scroll delta" })),
	scrollY: Type.Optional(Type.Number({ description: "Vertical scroll delta" })),
	executablePath: Type.Optional(Type.String({ description: "Explicit browser executable path override" })),
	recordingId: Type.Optional(Type.String({ description: "Recording ID for record_stop" })),
	format: Type.Optional(StringEnum(["mp4", "webm", "gif"] as const)),
	fps: Type.Optional(Type.Number({ description: "Recording frame rate (default 10, max 30)" })),
	ffmpegPath: Type.Optional(Type.String({ description: "ffmpeg executable path or command (default ffmpeg)" })),
});

export default function (pi: ExtensionAPI) {
	let manager: BrowserManager | undefined;

	pi.on("session_start", async (_event, ctx) => {
		manager = new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
	});

	pi.on("session_shutdown", async () => {
		if (!manager) return;
		await manager.closeAll();
		manager = undefined;
	});

	pi.registerCommand("browser-default", {
		description: "Choose the default browser for pi-puppeteer",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const detected = Object.entries(config.browsers).filter(([, definition]) => Boolean(definition.executablePath));

			let selectedKey = args.trim();
			if (selectedKey) {
				if (selectedKey !== "system") {
					const selected = config.browsers[selectedKey];
					if (!selected) {
						ctx.ui.notify(`Unknown browser key: ${selectedKey}`, "error");
						return;
					}
					if (!selected.executablePath) {
						ctx.ui.notify(`Browser '${selectedKey}' was not detected on this machine.`, "error");
						return;
					}
				}
			} else {
				const options = [
					{ key: "system", label: systemOptionLabel(config) },
					...detected.map(([key, definition]) => ({
						key,
						label: browserOptionLabel(key, definition, config.defaultBrowserSetting),
					})),
				];
				const choice = await ctx.ui.select("Select default browser:", options.map((option) => option.label));
				if (!choice) return;
				selectedKey = options.find((option) => option.label === choice)!.key;
			}

			await writeProjectDefaultBrowser(config, selectedKey);
			const nextConfig = loadConfig(ctx.cwd);
			manager?.setConfig(nextConfig);
			const resolved = selectedKey === "system" ? ` (resolves to '${nextConfig.defaultBrowser}')` : "";
			ctx.ui.notify(`Default browser set to '${selectedKey}'${resolved}.`, "info");
		},
	});

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: "Interact with a configured browser session. Supports launch, attach, navigation, clicks, typing, screenshots, text extraction, inspection, and ffmpeg-backed page recording.",
		promptSnippet: "Launch or attach to configured browsers, then navigate pages, interact with elements, inspect page state, capture screenshots, and record MP4/WebM/GIF browsing clips.",
		promptGuidelines: [
			"Use browser when the user wants Pi to interact with websites, tabs, forms, screenshots, or page inspection.",
			"Use browser start or browser attach before page actions when no active browser session exists.",
			"Use browser inspect or browser extract_text instead of dumping large page HTML into context.",
		],
		parameters: BrowserToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			const result = await manager.execute(params as BrowserToolInput);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});
}
