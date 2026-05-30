import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "puppeteer-core";

export type BrowserEngine = "chromium" | "firefox";
export type SessionMode = "launch" | "attach";
export type NavigationWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
export type RecordingFormat = "mp4" | "webm" | "gif";
export type ScriptFormat = "puppeteer" | "browser_tool";

export type BrowserAction =
	| "list_browsers"
	| "start"
	| "attach"
	| "sessions"
	| "show_session"
	| "rename_session"
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
	| "record_stop"
	| "workflow_record_start"
	| "workflow_record_stop"
	| "workflow_status"
	| "workflow_list"
	| "workflow_replay"
	| "workflow_details"
	| "workflow_rename"
	| "workflow_delete"
	| "workflow_export";

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
	name?: string;
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
	workflowRecordingId?: string;
	workflowId?: string;
	workflowName?: string;
	targetWorkflowName?: string;
	scriptFormat?: ScriptFormat;
}

export interface PageRecord {
	id: string;
	url: string;
	title: string;
	current: boolean;
}

export interface SessionSummary {
	id: string;
	name: string;
	browserKey: string;
	displayName: string;
	engine: BrowserEngine;
	mode: SessionMode;
	profile?: string;
	current: boolean;
	currentTabId?: string;
	tabCount: number;
	createdAt: number;
	lastActiveAt: number;
	currentUrl?: string;
	currentTitle?: string;
	tabs: PageRecord[];
}

export interface BrowserSessionRecord {
	id: string;
	name: string;
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
	lastActiveAt: number;
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

export interface WorkflowRecordingRecord {
	id: string;
	name: string;
	sessionId: string;
	tabId: string;
	page: Page;
	browserKey: string;
	profile?: string;
	startedAt: number;
	steps: WorkflowStep[];
	lastChangeKey?: string;
	lastScrollAt?: number;
	active: boolean;
}

export type WorkflowStep =
	| { type: "navigate"; url: string; timestamp?: number }
	| { type: "click"; selectors: string[][]; button?: number; url?: string; timestamp?: number }
	| { type: "change"; selectors: string[][]; value: string; url?: string; timestamp?: number }
	| { type: "keyDown"; key: string; url?: string; timestamp?: number }
	| { type: "scroll"; x: number; y: number; url?: string; timestamp?: number }
	| { type: "submit"; selectors: string[][]; url?: string; timestamp?: number }
	| { type: "waitForElement"; selectors: string[][]; timestamp?: number };

export interface SavedWorkflow {
	schemaVersion: 1;
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	browserKey?: string;
	profile?: string;
	steps: WorkflowStep[];
}

export interface WorkflowSummary {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	stepCount: number;
	startUrl: string | null;
}
