import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	BrowserDefinition,
	BrowserEngine,
	ExtensionDefaults,
	RawBrowserDefinition,
	RawExtensionConfig,
	ResolvedConfig,
} from "./types.ts";

const DEFAULTS: ExtensionDefaults = {
	headless: false,
	timeoutMs: 30_000,
	navigationWaitUntil: "domcontentloaded",
};

const DEFAULT_GLOBAL_CONFIG = join(getAgentDir(), "extensions", "pi-puppeteer.json");
const LEGACY_PROJECT_CONFIGS = [".pi/pi-puppeteer.json", ".pi/.pi-puppeteer/pi-puppeteer.json"];
const PROJECT_CONFIG = ".pi/.pi-puppeteer/settings.json";
const LEGACY_STORAGE_ROOT = ".pi-puppeteer";
const STORAGE_ROOT = ".pi/.pi-puppeteer";
const LEGACY_PROFILE_ROOT = ".pi-puppeteer/profiles";
const LEGACY_ARTIFACT_ROOT = ".pi-puppeteer/artifacts";
const DEFAULT_PROFILE_ROOT = ".pi/.pi-puppeteer/profiles";
const DEFAULT_ARTIFACT_ROOT = ".pi/.pi-puppeteer/artifacts";

function unique(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function pathCandidates(commands: string[]): string[] {
	const pathValue = process.env.PATH ?? "";
	return unique(pathValue.split(delimiter).flatMap((directory) => commands.map((command) => join(directory, command))));
}

function macAppCandidates(appName: string, executableName = appName): string[] {
	return [
		join("/Applications", `${appName}.app`, "Contents", "MacOS", executableName),
		join(os.homedir(), "Applications", `${appName}.app`, "Contents", "MacOS", executableName),
	];
}

function browserCandidates(key: string, engine: BrowserEngine): string[] {
	const home = os.homedir();
	const platform = process.platform;
	const programFiles = process.env.PROGRAMFILES;
	const programFilesX86 = process.env["PROGRAMFILES(X86)"];
	const localAppData = process.env.LOCALAPPDATA;

	if (platform === "win32") {
		switch (key) {
			case "chrome":
				return unique([
					localAppData ? join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : undefined,
					programFiles ? join(programFiles, "Google", "Chrome", "Application", "chrome.exe") : undefined,
					programFilesX86 ? join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") : undefined,
				]);
			case "edge":
				return unique([
					localAppData ? join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
					programFiles ? join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
					programFilesX86 ? join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
				]);
			case "brave":
				return unique([
					localAppData
						? join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
						: undefined,
					programFiles
						? join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
						: undefined,
					programFilesX86
						? join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
						: undefined,
				]);
			case "opera":
				return unique([
					localAppData ? join(localAppData, "Opera", "opera.exe") : undefined,
					programFiles ? join(programFiles, "Opera", "opera.exe") : undefined,
					programFilesX86 ? join(programFilesX86, "Opera", "opera.exe") : undefined,
					localAppData ? join(localAppData, "Programs", "Opera", "opera.exe") : undefined,
					localAppData ? join(localAppData, "Programs", "Opera", "launcher.exe") : undefined,
					programFiles ? join(programFiles, "Opera", "launcher.exe") : undefined,
					programFilesX86 ? join(programFilesX86, "Opera", "launcher.exe") : undefined,
				]);
			case "vivaldi":
				return unique([
					localAppData ? join(localAppData, "Vivaldi", "Application", "vivaldi.exe") : undefined,
					programFiles ? join(programFiles, "Vivaldi", "Application", "vivaldi.exe") : undefined,
					programFilesX86 ? join(programFilesX86, "Vivaldi", "Application", "vivaldi.exe") : undefined,
				]);
			case "yandex":
				return unique([
					localAppData ? join(localAppData, "Yandex", "YandexBrowser", "Application", "browser.exe") : undefined,
					programFiles ? join(programFiles, "Yandex", "YandexBrowser", "Application", "browser.exe") : undefined,
					programFilesX86 ? join(programFilesX86, "Yandex", "YandexBrowser", "Application", "browser.exe") : undefined,
				]);
			case "firefox":
				return unique([
					localAppData ? join(localAppData, "Mozilla Firefox", "firefox.exe") : undefined,
					programFiles ? join(programFiles, "Mozilla Firefox", "firefox.exe") : undefined,
					programFilesX86 ? join(programFilesX86, "Mozilla Firefox", "firefox.exe") : undefined,
				]);
			default:
				return [];
		}
	}

	if (platform === "darwin") {
		switch (key) {
			case "chrome":
				return macAppCandidates("Google Chrome");
			case "edge":
				return macAppCandidates("Microsoft Edge");
			case "brave":
				return macAppCandidates("Brave Browser");
			case "opera":
				return macAppCandidates("Opera");
			case "vivaldi":
				return macAppCandidates("Vivaldi");
			case "yandex":
				return [...macAppCandidates("Yandex"), ...macAppCandidates("Yandex Browser")];
			case "firefox":
				return macAppCandidates("Firefox", "firefox");
			default:
				return [];
		}
	}

	if (platform === "linux") {
		switch (key) {
			case "chrome":
				return unique([
					...pathCandidates(["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]),
					"/usr/bin/google-chrome",
					"/usr/bin/google-chrome-stable",
					"/usr/bin/chromium-browser",
					"/usr/bin/chromium",
				]);
			case "edge":
				return unique([
					...pathCandidates(["microsoft-edge", "microsoft-edge-stable"]),
					"/usr/bin/microsoft-edge",
					"/usr/bin/microsoft-edge-stable",
				]);
			case "brave":
				return unique([
					...pathCandidates(["brave-browser", "brave"]),
					"/usr/bin/brave-browser",
					"/usr/bin/brave",
				]);
			case "opera":
				return unique([...pathCandidates(["opera", "opera-stable"]), "/usr/bin/opera", "/usr/bin/opera-stable"]);
			case "vivaldi":
				return unique([
					...pathCandidates(["vivaldi", "vivaldi-stable"]),
					"/usr/bin/vivaldi",
					"/usr/bin/vivaldi-stable",
				]);
			case "yandex":
				return unique([
					...pathCandidates(["yandex-browser", "yandex-browser-stable"]),
					"/usr/bin/yandex-browser",
					"/usr/bin/yandex-browser-stable",
				]);
			case "firefox":
				return unique([
					...pathCandidates(["firefox"]),
					"/usr/bin/firefox",
					"/usr/local/bin/firefox",
					"/snap/bin/firefox",
					"/opt/firefox/firefox",
				]);
			default:
				return [];
		}
	}

	if (engine === "firefox") {
		return [join(home, "bin", "firefox")];
	}

	return [];
}

function defaultBrowserDefinitions(): Record<string, BrowserDefinition> {
	return {
		chrome: {
			displayName: "Google Chrome",
			engine: "chromium",
			launchArgs: [],
			attach: { browserURL: "http://127.0.0.1:9222" },
			discovered: false,
			discoveryCandidates: browserCandidates("chrome", "chromium"),
		},
		edge: {
			displayName: "Microsoft Edge",
			engine: "chromium",
			launchArgs: [],
			attach: { browserURL: "http://127.0.0.1:9222" },
			discovered: false,
			discoveryCandidates: browserCandidates("edge", "chromium"),
		},
		brave: {
			displayName: "Brave",
			engine: "chromium",
			launchArgs: [],
			attach: { browserURL: "http://127.0.0.1:9222" },
			discovered: false,
			discoveryCandidates: browserCandidates("brave", "chromium"),
		},
		opera: {
			displayName: "Opera",
			engine: "chromium",
			launchArgs: [],
			attach: { browserURL: "http://127.0.0.1:9222" },
			discovered: false,
			discoveryCandidates: browserCandidates("opera", "chromium"),
		},
		vivaldi: {
			displayName: "Vivaldi",
			engine: "chromium",
			launchArgs: [],
			attach: { browserURL: "http://127.0.0.1:9222" },
			discovered: false,
			discoveryCandidates: browserCandidates("vivaldi", "chromium"),
		},
		yandex: {
			displayName: "Yandex Browser",
			engine: "chromium",
			launchArgs: [],
			attach: { browserURL: "http://127.0.0.1:9222" },
			discovered: false,
			discoveryCandidates: browserCandidates("yandex", "chromium"),
		},
		firefox: {
			displayName: "Firefox",
			engine: "firefox",
			launchArgs: [],
			discovered: false,
			discoveryCandidates: browserCandidates("firefox", "firefox"),
		},
	};
}

function mergeBrowserDefinition(base: BrowserDefinition | undefined, override: RawBrowserDefinition): BrowserDefinition {
	const engine = override.engine ?? base?.engine ?? "chromium";
	const candidates = base?.discoveryCandidates ?? [];
	const configuredPath = override.executablePath ?? base?.executablePath;
	const discoveredPath = configuredPath ?? candidates.find((candidate) => existsSync(candidate));

	return {
		displayName: override.displayName ?? base?.displayName ?? "Custom Browser",
		engine,
		executablePath: discoveredPath,
		launchArgs: override.launchArgs ?? base?.launchArgs ?? [],
		attach: override.attach ?? base?.attach,
		discovered: Boolean(discoveredPath && !override.executablePath),
		discoveryCandidates: candidates.length ? candidates : browserCandidates("custom", engine),
	};
}

function readJson(path: string): RawExtensionConfig {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RawExtensionConfig;
	} catch (error) {
		throw new Error(`Failed to parse config ${path}: ${(error as Error).message}`);
	}
}

function resolveMaybeRelative(root: string, value: string): string {
	if (isAbsolute(value)) return value;
	if (value.startsWith("~/")) return join(os.homedir(), value.slice(2));
	return resolve(root, value);
}

function normalizeConfigPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolveStorageRoot(cwd: string, value: string | undefined, legacyDefault: string, nextDefault: string): string {
	const shouldUseDefault = value === undefined || normalizeConfigPath(value) === normalizeConfigPath(legacyDefault);
	return resolveMaybeRelative(cwd, shouldUseDefault ? nextDefault : value);
}

function uniqueMigrationPath(path: string): string {
	let candidate = `${path}.legacy`;
	let counter = 1;
	while (existsSync(candidate)) {
		candidate = `${path}.legacy-${counter++}`;
	}
	return candidate;
}

function moveFile(source: string, target: string): void {
	mkdirSync(dirname(target), { recursive: true });
	try {
		renameSync(source, target);
		return;
	} catch {
		try {
			copyFileSync(source, target);
		} catch {
			// Locked browser profile files may remain in the legacy folder until the browser exits.
			return;
		}
		try {
			unlinkSync(source);
		} catch {
			// Locked browser profile files may remain in the legacy folder until the browser exits.
		}
	}
}

function moveDirectory(source: string, target: string): void {
	try {
		renameSync(source, target);
		return;
	} catch {
		moveStorageContents(source, target);
	}
}

function moveStorageContents(source: string, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const sourcePath = join(source, entry.name);
		const targetPath = join(target, entry.name);
		if (!existsSync(targetPath)) {
			if (entry.isDirectory()) moveDirectory(sourcePath, targetPath);
			else moveFile(sourcePath, targetPath);
			continue;
		}

		if (entry.isDirectory() && statSync(targetPath).isDirectory()) {
			moveStorageContents(sourcePath, targetPath);
			continue;
		}

		const migratedPath = uniqueMigrationPath(targetPath);
		if (entry.isDirectory()) moveDirectory(sourcePath, migratedPath);
		else moveFile(sourcePath, migratedPath);
	}
	try {
		rmdirSync(source);
	} catch {
		// Leave non-empty legacy folders in place if files are locked by a running browser.
	}
}

function migrateLegacyStorage(cwd: string): void {
	const legacyRoot = join(cwd, LEGACY_STORAGE_ROOT);
	if (!existsSync(legacyRoot)) return;

	const storageRoot = join(cwd, STORAGE_ROOT);
	mkdirSync(dirname(storageRoot), { recursive: true });
	if (!existsSync(storageRoot)) {
		renameSync(legacyRoot, storageRoot);
		return;
	}

	moveStorageContents(legacyRoot, storageRoot);
}

function migrateProjectConfig(cwd: string): void {
	const projectConfigPath = join(cwd, PROJECT_CONFIG);
	mkdirSync(dirname(projectConfigPath), { recursive: true });

	for (const legacyConfig of LEGACY_PROJECT_CONFIGS) {
		const legacyConfigPath = join(cwd, legacyConfig);
		if (!existsSync(legacyConfigPath)) continue;

		if (!existsSync(projectConfigPath)) {
			moveFile(legacyConfigPath, projectConfigPath);
			continue;
		}

		moveFile(legacyConfigPath, uniqueMigrationPath(projectConfigPath));
	}
}

export function loadConfig(cwd: string): ResolvedConfig {
	migrateLegacyStorage(cwd);
	migrateProjectConfig(cwd);

	const projectConfigPath = join(cwd, PROJECT_CONFIG);
	const globalConfig = readJson(DEFAULT_GLOBAL_CONFIG);
	const projectConfig = readJson(projectConfigPath);

	const mergedDefaults: ExtensionDefaults = {
		...DEFAULTS,
		...(globalConfig.defaults ?? {}),
		...(projectConfig.defaults ?? {}),
	};

	const baseBrowsers = defaultBrowserDefinitions();
	const mergedBrowsers: Record<string, BrowserDefinition> = { ...baseBrowsers };

	for (const [key, override] of Object.entries(globalConfig.browsers ?? {})) {
		mergedBrowsers[key] = mergeBrowserDefinition(baseBrowsers[key], override);
	}
	for (const [key, override] of Object.entries(projectConfig.browsers ?? {})) {
		mergedBrowsers[key] = mergeBrowserDefinition(mergedBrowsers[key], override);
	}

	for (const [key, definition] of Object.entries(mergedBrowsers)) {
		if (!definition.executablePath) {
			const discovered = definition.discoveryCandidates.find((candidate) => existsSync(candidate));
			if (discovered) {
				definition.executablePath = discovered;
				definition.discovered = true;
			}
		}
		if (!definition.discoveryCandidates.length) {
			definition.discoveryCandidates = browserCandidates(key, definition.engine);
		}
	}

	const defaultBrowser = projectConfig.defaultBrowser ?? globalConfig.defaultBrowser ?? "chrome";
	const profileRoot = resolveStorageRoot(cwd, projectConfig.profileRoot ?? globalConfig.profileRoot, LEGACY_PROFILE_ROOT, DEFAULT_PROFILE_ROOT);
	const artifactRoot = resolveStorageRoot(cwd, projectConfig.artifactRoot ?? globalConfig.artifactRoot, LEGACY_ARTIFACT_ROOT, DEFAULT_ARTIFACT_ROOT);

	return {
		defaultBrowser,
		profileRoot,
		artifactRoot,
		defaults: mergedDefaults,
		browsers: mergedBrowsers,
		configPaths: {
			global: DEFAULT_GLOBAL_CONFIG,
			project: projectConfigPath,
		},
	};
}
