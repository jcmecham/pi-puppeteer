import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "puppeteer-core";

export type BrowserEngine = "chromium" | "firefox";
export type SessionMode = "launch" | "attach";
export type NavigationWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
export type RecordingFormat = "mp4" | "webm" | "gif";

export type BrowserAction =
	| "list_browsers"
	| "start"
	| "attach"
	| "sessions"
	| "stop"
	| "tabs"
	| "new_tab"
	| "select_tab"
	| "close_tab"
	| "navigate"
	| "click"
	| "type"
	| "press"
	| "scroll"
	| "wait_for"
	| "extract_text"
	| "inspect"
	| "screenshot"
	| "record_start"
	| "record_stop";

export interface AttachConfig {
	browserURL?: string;
	browserWSEndpoint?: string;
}

export interface BrowserDefinition {
	displayName: string;
	engine: BrowserEngine;
	executablePath?: string;
	launchArgs: string[];
	attach?: AttachConfig;
	discovered: boolean;
	discoveryCandidates: string[];
}

export interface RawBrowserDefinition {
	displayName?: string;
	engine?: BrowserEngine;
	executablePath?: string;
	launchArgs?: string[];
	attach?: AttachConfig;
}

export interface ExtensionDefaults {
	headless: boolean;
	timeoutMs: number;
	navigationWaitUntil: NavigationWaitUntil;
}

export interface RawExtensionConfig {
	defaultBrowser?: string;
	profileRoot?: string;
	artifactRoot?: string;
	defaults?: Partial<ExtensionDefaults>;
	browsers?: Record<string, RawBrowserDefinition>;
}

export interface ResolvedConfig {
	/** Resolved browser key used by tools. "system" resolves to the OS default browser when supported. */
	defaultBrowser: string;
	/** Raw default browser setting after config precedence; "system" means use the OS default browser. */
	defaultBrowserSetting: string;
	/** Detected OS default browser key, or the built-in fallback when detection is unsupported. */
	systemDefaultBrowser: string;
	profileRoot: string;
	artifactRoot: string;
	defaults: ExtensionDefaults;
	browsers: Record<string, BrowserDefinition>;
	configPaths: {
		global: string;
		project: string;
	};
}

export interface BrowserToolInput {
	action: BrowserAction;
	browserKey?: string;
	sessionId?: string;
	tabId?: string;
	profile?: string;
	url?: string;
	selector?: string;
	text?: string;
	key?: string;
	path?: string;
	endpoint?: string;
	headless?: boolean;
	timeoutMs?: number;
	waitUntil?: NavigationWaitUntil;
	replace?: boolean;
	fullPage?: boolean;
	scrollX?: number;
	scrollY?: number;
	executablePath?: string;
	recordingId?: string;
	format?: RecordingFormat;
	fps?: number;
	ffmpegPath?: string;
}

export interface PageRecord {
	id: string;
	url: string;
	title: string;
	current: boolean;
}

export interface SessionSummary {
	id: string;
	browserKey: string;
	displayName: string;
	engine: BrowserEngine;
	mode: SessionMode;
	profile?: string;
	current: boolean;
	currentTabId?: string;
	tabCount: number;
}

export interface BrowserSessionRecord {
	id: string;
	browserKey: string;
	displayName: string;
	engine: BrowserEngine;
	mode: SessionMode;
	profile?: string;
	browser: Browser;
	pages: Map<string, Page>;
	currentPageId?: string;
	nextTabNumber: number;
	createdAt: number;
	// Teardown for launch-mode sessions; undefined for attach-mode sessions.
	dispose?: () => Promise<void>;
}

export interface RecordingRecord {
	id: string;
	sessionId: string;
	tabId: string;
	page: Page;
	outputPath: string;
	format: RecordingFormat;
	fps: number;
	process: ChildProcess;
	startedAt: number;
	frameCount: number;
	active: boolean;
	busy: boolean;
	timer: NodeJS.Timeout;
	stderr: string;
	exitCode?: number | null;
}
