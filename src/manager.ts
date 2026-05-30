import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "puppeteer-core";
import { getAdapter } from "./adapters/index.ts";
import {
	createWorkflowId,
	deleteWorkflow,
	findFirstSelector,
	generateBrowserToolCalls,
	generateBrowserToolScript,
	generatePuppeteerScript,
	injectedWorkflowRecorder,
	listWorkflows,
	readWorkflow,
	renameWorkflow,
	sanitizeWorkflowSegment,
	summarizeWorkflow,
	workflowRoot,
	writeWorkflow,
} from "./workflows.ts";
import type {
	BrowserSessionRecord,
	BrowserToolInput,
	PageRecord,
	RecordingFormat,
	RecordingRecord,
	ResolvedConfig,
	SavedWorkflow,
	SessionSummary,
	WorkflowRecordingRecord,
	WorkflowStep,
} from "./types.ts";

interface ToolResponse {
	text: string;
	details: Record<string, unknown>;
}

const require = createRequire(import.meta.url);
const bundledFfmpegPath = require("ffmpeg-static") as string | null;
const WORKFLOW_RECORDER_FUNCTION = "__piPuppeteerWorkflowRecord";

function truncate(value: string, max = 4000): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated]`;
}

function sanitizeSegment(value: string | undefined, fallback: string): string {
	const base = (value ?? fallback).trim() || fallback;
	return base.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export class BrowserManager {
	private sessions = new Map<string, BrowserSessionRecord>();
	private recordings = new Map<string, RecordingRecord>();
	private workflowRecordings = new Map<string, WorkflowRecordingRecord>();
	private workflowRecorderInjectedPages = new WeakSet<Page>();
	private currentSessionId?: string;
	private nextSessionNumber = 1;
	private nextRecordingNumber = 1;
	private nextWorkflowRecordingNumber = 1;

	constructor(
		private readonly cwd: string,
		private config: ResolvedConfig,
	) {}

	setConfig(config: ResolvedConfig): void {
		this.config = config;
	}

	async closeAll(): Promise<void> {
		for (const workflowRecording of [...this.workflowRecordings.values()]) {
			await this.stopWorkflowRecording(workflowRecording).catch(() => undefined);
		}
		for (const session of [...this.sessions.values()]) {
			await this.stopSession(session);
		}
		this.workflowRecordings.clear();
		this.sessions.clear();
		this.currentSessionId = undefined;
	}

	async execute(input: BrowserToolInput): Promise<ToolResponse> {
		switch (input.action) {
			case "list_browsers":
				return this.listBrowsers();
			case "start":
				return this.start(input);
			case "attach":
				return this.attach(input);
			case "sessions":
				return this.listSessions();
			case "stop":
				return this.stop(input.sessionId);
			case "tabs":
				return this.listTabs(input.sessionId);
			case "new_tab":
				return this.newTab(input);
			case "select_tab":
				return this.selectTab(input);
			case "close_tab":
				return this.closeTab(input);
			case "navigate":
				return this.navigate(input);
			case "click":
				return this.click(input);
			case "type":
				return this.typeText(input);
			case "press":
				return this.press(input);
			case "scroll":
				return this.scroll(input);
			case "wait_for":
				return this.waitFor(input);
			case "extract_text":
				return this.extractText(input);
			case "inspect":
				return this.inspect(input);
			case "screenshot":
				return this.screenshot(input);
			case "record_start":
				return this.recordStart(input);
			case "record_stop":
				return this.recordStop(input);
			case "workflow_record_start":
				return this.workflowRecordStart(input);
			case "workflow_record_stop":
				return this.workflowRecordStop(input);
			case "workflow_status":
				return this.workflowStatus();
			case "workflow_list":
				return this.workflowList();
			case "workflow_replay":
				return this.workflowReplay(input);
			case "workflow_details":
				return this.workflowDetails(input);
			case "workflow_rename":
				return this.workflowRename(input);
			case "workflow_delete":
				return this.workflowDelete(input);
			case "workflow_export":
				return this.workflowExport(input);
			default:
				throw new Error(`Unsupported browser action: ${String(input.action)}`);
		}
	}

	private listBrowsers(): ToolResponse {
		const browsers = Object.entries(this.config.browsers)
			.filter(([, value]) => Boolean(value.executablePath))
			.map(([key, value]) => ({
				key,
				displayName: value.displayName,
				engine: value.engine,
				executablePath: value.executablePath ?? null,
				discovered: value.discovered,
				attach: value.attach ?? null,
			}));

		const lines = browsers.map(
			(browser) => `${browser.key}: ${browser.displayName} (${browser.engine}) — ${browser.executablePath}`,
		);

		return {
			text: lines.length
				? `Available browsers:\n${lines.join("\n")}`
				: "No browsers were discovered on this machine.",
			details: {
				action: "list_browsers",
				defaultBrowser: this.config.defaultBrowser,
				defaultBrowserSetting: this.config.defaultBrowserSetting,
				systemDefaultBrowser: this.config.systemDefaultBrowser,
				configPaths: this.config.configPaths,
				browsers,
			},
		};
	}

	private async start(input: BrowserToolInput): Promise<ToolResponse> {
		const browserKey = this.resolveBrowserKey(input.browserKey);
		const definition = this.config.browsers[browserKey];
		if (!definition) {
			throw new Error(`Unknown browser key: ${browserKey}`);
		}

		const executablePath = input.executablePath ?? definition.executablePath;
		if (!executablePath) {
			throw new Error(
				`No executable path configured or discovered for '${browserKey}'. Set it in ${this.config.configPaths.project} or ${this.config.configPaths.global}.`,
			);
		}

		const profile = sanitizeSegment(input.profile, "default");
		const userDataDir = join(this.config.profileRoot, browserKey, profile);
		await mkdir(userDataDir, { recursive: true });

		const { browser, dispose } = await getAdapter(definition.engine).launch(definition, {
			executablePath,
			headless: input.headless ?? this.config.defaults.headless,
			userDataDir,
		});

		const session = await this.registerSession({
			browser,
			browserKey,
			displayName: definition.displayName,
			engine: definition.engine,
			mode: "launch",
			profile,
			dispose,
		});

		const tabs = await this.syncPages(session);
		const currentPage = await this.resolvePage(session);
		if (input.url) {
			await currentPage.goto(input.url, {
				waitUntil: input.waitUntil ?? this.config.defaults.navigationWaitUntil,
				timeout: input.timeoutMs ?? this.config.defaults.timeoutMs,
			});
			this.recordWorkflowStep(session.id, session.currentPageId, { type: "navigate", url: currentPage.url(), timestamp: Date.now() });
		}

		return {
			text: `Started ${definition.displayName} as ${session.id}${input.url ? ` and opened ${input.url}` : ""}.`,
			details: {
				action: "start",
				session: await this.summarizeSession(session),
				tabs,
				profilePath: userDataDir,
			},
		};
	}

	private async attach(input: BrowserToolInput): Promise<ToolResponse> {
		const browserKey = this.resolveBrowserKey(input.browserKey);
		const definition = this.config.browsers[browserKey];
		if (!definition) {
			throw new Error(`Unknown browser key: ${browserKey}`);
		}
		const endpoint = input.endpoint ?? definition.attach?.browserWSEndpoint ?? definition.attach?.browserURL ?? "http://127.0.0.1:9222";
		const browser = await getAdapter(definition.engine).attach(definition, endpoint);

		const session = await this.registerSession({
			browser,
			browserKey,
			displayName: definition.displayName,
			engine: definition.engine,
			mode: "attach",
		});
		const tabs = await this.syncPages(session);

		return {
			text: `Attached to ${definition.displayName} at ${endpoint} as ${session.id}.`,
			details: {
				action: "attach",
				endpoint,
				session: await this.summarizeSession(session),
				tabs,
			},
		};
	}

	private async listSessions(): Promise<ToolResponse> {
		const sessions = await Promise.all([...this.sessions.values()].map((session) => this.summarizeSession(session)));
		if (!sessions.length) {
			return {
				text: "No browser sessions are active.",
				details: { action: "sessions", sessions: [] },
			};
		}

		return {
			text: `Active sessions:\n${sessions
				.map((session) => `${session.id}: ${session.displayName} (${session.mode}, ${session.tabCount} tab${session.tabCount === 1 ? "" : "s"})`)
				.join("\n")}`,
			details: { action: "sessions", currentSessionId: this.currentSessionId ?? null, sessions },
		};
	}

	private async stop(sessionId?: string): Promise<ToolResponse> {
		const session = this.resolveSession(sessionId);
		await this.stopSession(session);
		this.sessions.delete(session.id);
		if (this.currentSessionId === session.id) {
			this.currentSessionId = this.sessions.keys().next().value;
		}
		return {
			text: `Stopped ${session.id}.`,
			details: { action: "stop", sessionId: session.id },
		};
	}

	private async listTabs(sessionId?: string): Promise<ToolResponse> {
		const session = this.resolveSession(sessionId);
		const tabs = await this.syncPages(session);
		return {
			text: tabs.length
				? `Tabs for ${session.id}:\n${tabs.map((tab) => `${tab.id}${tab.current ? " *" : ""}: ${tab.title || "(untitled)"} — ${tab.url}`).join("\n")}`
				: `No tabs are open in ${session.id}.`,
			details: { action: "tabs", sessionId: session.id, tabs },
		};
	}

	private async newTab(input: BrowserToolInput): Promise<ToolResponse> {
		const session = this.resolveSession(input.sessionId);
		const page = await session.browser.newPage();
		if (input.url) {
			await page.goto(input.url, {
				waitUntil: input.waitUntil ?? this.config.defaults.navigationWaitUntil,
				timeout: input.timeoutMs ?? this.config.defaults.timeoutMs,
			});
		}
		const tabs = await this.syncPages(session);
		const created = tabs.find((tab) => session.pages.get(tab.id) === page);
		if (created) session.currentPageId = created.id;
		if (input.url) {
			this.recordWorkflowStep(session.id, created?.id, { type: "navigate", url: page.url(), timestamp: Date.now() });
		}
		return {
			text: `Created ${created?.id ?? "a new tab"}${input.url ? ` and opened ${input.url}` : ""}.`,
			details: { action: "new_tab", sessionId: session.id, tab: created ?? null, tabs },
		};
	}

	private async selectTab(input: BrowserToolInput): Promise<ToolResponse> {
		if (!input.tabId) throw new Error("tabId is required for select_tab.");
		const session = this.resolveSession(input.sessionId);
		await this.syncPages(session);
		if (!session.pages.has(input.tabId)) {
			throw new Error(`Unknown tab '${input.tabId}' in ${session.id}.`);
		}
		session.currentPageId = input.tabId;
		const page = session.pages.get(input.tabId)!;
		await page.bringToFront().catch(() => undefined);
		return {
			text: `Selected ${input.tabId} in ${session.id}.`,
			details: { action: "select_tab", sessionId: session.id, tabId: input.tabId, url: page.url() },
		};
	}

	private async closeTab(input: BrowserToolInput): Promise<ToolResponse> {
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		const closingId = input.tabId ?? session.currentPageId;
		if (closingId) {
			await this.stopSessionRecordings(session.id, closingId);
			await this.stopSessionWorkflowRecordings(session.id, closingId);
		}
		await page.close();
		const tabs = await this.syncPages(session);
		return {
			text: `Closed ${closingId ?? "the current tab"}.`,
			details: { action: "close_tab", sessionId: session.id, tabs },
		};
	}

	private async navigate(input: BrowserToolInput): Promise<ToolResponse> {
		if (!input.url) throw new Error("url is required for navigate.");
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		await page.goto(input.url, {
			waitUntil: input.waitUntil ?? this.config.defaults.navigationWaitUntil,
			timeout: input.timeoutMs ?? this.config.defaults.timeoutMs,
		});
		this.recordWorkflowStep(session.id, session.currentPageId, { type: "navigate", url: page.url(), timestamp: Date.now() });
		return {
			text: `Navigated ${session.id}/${session.currentPageId} to ${page.url()}.`,
			details: {
				action: "navigate",
				sessionId: session.id,
				tabId: session.currentPageId,
				url: page.url(),
				title: await page.title().catch(() => ""),
			},
		};
	}

	private async click(input: BrowserToolInput): Promise<ToolResponse> {
		if (!input.selector) throw new Error("selector is required for click.");
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		await page.waitForSelector(input.selector, { timeout: input.timeoutMs ?? this.config.defaults.timeoutMs });
		await page.click(input.selector);
		return {
			text: `Clicked ${input.selector} in ${session.id}/${session.currentPageId}.`,
			details: { action: "click", sessionId: session.id, tabId: session.currentPageId, selector: input.selector },
		};
	}

	private async typeText(input: BrowserToolInput): Promise<ToolResponse> {
		if (!input.selector) throw new Error("selector is required for type.");
		if (input.text === undefined) throw new Error("text is required for type.");
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		await page.waitForSelector(input.selector, { timeout: input.timeoutMs ?? this.config.defaults.timeoutMs });
		await page.click(input.selector, { clickCount: input.replace === false ? 1 : 3 });
		if (input.replace !== false) {
			await page.keyboard.press("Backspace");
		}
		await page.type(input.selector, input.text);
		return {
			text: `Typed into ${input.selector} in ${session.id}/${session.currentPageId}.`,
			details: {
				action: "type",
				sessionId: session.id,
				tabId: session.currentPageId,
				selector: input.selector,
				textLength: input.text.length,
			},
		};
	}

	private async press(input: BrowserToolInput): Promise<ToolResponse> {
		if (!input.key) throw new Error("key is required for press.");
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		if (input.selector) {
			await page.waitForSelector(input.selector, { timeout: input.timeoutMs ?? this.config.defaults.timeoutMs });
			await page.focus(input.selector);
		}
		await page.keyboard.press(input.key as Parameters<typeof page.keyboard.press>[0]);
		return {
			text: `Pressed ${input.key} in ${session.id}/${session.currentPageId}.`,
			details: { action: "press", sessionId: session.id, tabId: session.currentPageId, key: input.key, selector: input.selector ?? null },
		};
	}

	private async scroll(input: BrowserToolInput): Promise<ToolResponse> {
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		const scrollX = input.scrollX ?? 0;
		const scrollY = input.scrollY ?? 800;
		const position = await page.evaluate(
			({ x, y }) => {
				window.scrollBy(x, y);
				return { x: window.scrollX, y: window.scrollY };
			},
			{ x: scrollX, y: scrollY },
		);
		return {
			text: `Scrolled ${session.id}/${session.currentPageId} to (${position.x}, ${position.y}).`,
			details: { action: "scroll", sessionId: session.id, tabId: session.currentPageId, position },
		};
	}

	private async waitFor(input: BrowserToolInput): Promise<ToolResponse> {
		if (!input.selector) throw new Error("selector is required for wait_for.");
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		await page.waitForSelector(input.selector, { timeout: input.timeoutMs ?? this.config.defaults.timeoutMs });
		return {
			text: `Selector ${input.selector} is ready in ${session.id}/${session.currentPageId}.`,
			details: { action: "wait_for", sessionId: session.id, tabId: session.currentPageId, selector: input.selector },
		};
	}

	private async extractText(input: BrowserToolInput): Promise<ToolResponse> {
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		const text = input.selector
			? await page.$eval(input.selector, (node) => ((node as HTMLElement).innerText || node.textContent || "").trim())
			: await page.evaluate(() => document.body?.innerText?.trim() ?? "");
		const trimmed = truncate(text, 3500);
		return {
			text: trimmed || "No text found.",
			details: {
				action: "extract_text",
				sessionId: session.id,
				tabId: session.currentPageId,
				selector: input.selector ?? null,
				length: text.length,
			},
		};
	}

	private async inspect(input: BrowserToolInput): Promise<ToolResponse> {
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		const summary = await page.evaluate((selector) => {
			const target = selector ? document.querySelector(selector) : document.body;
			if (!target) {
				return {
					missing: true,
					selector,
					title: document.title,
					url: location.href,
				};
			}

			const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
				.slice(0, 10)
				.map((node) => ({
					tag: node.tagName.toLowerCase(),
					text: (((node as HTMLElement).innerText || node.textContent || "").replace(/\s+/g, " ").trim()),
				}));
			const links = Array.from(document.querySelectorAll("a[href]"))
				.slice(0, 10)
				.map((node) => ({
					text: (((node as HTMLElement).innerText || node.textContent || "").replace(/\s+/g, " ").trim()),
					href: (node as HTMLAnchorElement).href,
				}));
			const forms = Array.from(document.forms)
				.slice(0, 5)
				.map((form) => ({ action: form.action || null, method: form.method || "get", inputs: form.querySelectorAll("input, textarea, select").length }));
			const activeElement = document.activeElement as HTMLElement | null;

			return {
				missing: false,
				selector,
				title: document.title,
				url: location.href,
				readyState: document.readyState,
				tagName: target.tagName?.toLowerCase() ?? null,
				id: (target as HTMLElement).id || null,
				classes: Array.from(target.classList ?? []),
				textSample: (((target as HTMLElement).innerText || target.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 1200),
				headings,
				links,
				forms,
				activeElement: activeElement
					? {
						tagName: activeElement.tagName.toLowerCase(),
						id: activeElement.id || null,
						name: activeElement.getAttribute("name"),
					}
					: null,
			};
		}, input.selector ?? null);

		let accessibility: unknown = null;
		try {
			accessibility = await page.accessibility.snapshot({ interestingOnly: true });
		} catch {
			accessibility = null;
		}

		const text = truncate(JSON.stringify({ ...summary, accessibility }, null, 2), 3800);
		return {
			text,
			details: {
				action: "inspect",
				sessionId: session.id,
				tabId: session.currentPageId,
				summary,
				hasAccessibility: accessibility !== null,
			},
		};
	}

	private async screenshot(input: BrowserToolInput): Promise<ToolResponse> {
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		const outputPath = input.path
			? resolve(this.cwd, input.path)
			: join(this.config.artifactRoot, "screenshots", `${session.id}-${Date.now()}.png`);
		await mkdir(dirname(outputPath), { recursive: true });
		await page.screenshot({
			path: outputPath,
			fullPage: input.fullPage ?? true,
			type: "png",
		});
		return {
			text: `Saved screenshot to ${this.displayPath(outputPath)}.`,
			details: {
				action: "screenshot",
				sessionId: session.id,
				tabId: session.currentPageId,
				path: outputPath,
			},
		};
	}

	private async recordStart(input: BrowserToolInput): Promise<ToolResponse> {
		const session = this.resolveSession(input.sessionId);
		const page = await this.resolvePage(session, input.tabId);
		const tabId = session.currentPageId;
		if (!tabId) throw new Error("No tab is active to record.");

		const format = this.resolveRecordingFormat(input);
		const fps = Math.max(1, Math.min(30, Math.round(input.fps ?? 10)));
		const outputPath = input.path
			? resolve(this.cwd, input.path)
			: join(this.config.artifactRoot, "recordings", `${session.id}-${sanitizeSegment(tabId, "tab")}-${Date.now()}.${format}`);
		await mkdir(dirname(outputPath), { recursive: true });

		const ffmpegPath = input.ffmpegPath ?? bundledFfmpegPath ?? "ffmpeg";
		const ffmpeg = spawn(ffmpegPath, this.ffmpegArgs(format, fps, outputPath), {
			stdio: ["pipe", "ignore", "pipe"],
		});
		await this.waitForSpawn(ffmpeg, ffmpegPath);

		const recording: RecordingRecord = {
			id: `recording-${this.nextRecordingNumber++}`,
			sessionId: session.id,
			tabId,
			page,
			outputPath,
			format,
			fps,
			process: ffmpeg,
			startedAt: Date.now(),
			frameCount: 0,
			active: true,
			busy: false,
			timer: setInterval(() => {
				void this.captureRecordingFrame(recording);
			}, Math.round(1000 / fps)),
			stderr: "",
		};

		ffmpeg.stderr?.on("data", (chunk: Buffer) => {
			recording.stderr = truncate(`${recording.stderr}${chunk.toString("utf8")}`, 5000);
		});
		ffmpeg.on("exit", (code) => {
			recording.exitCode = code;
			recording.active = false;
			clearInterval(recording.timer);
		});

		this.recordings.set(recording.id, recording);
		await this.captureRecordingFrame(recording);

		return {
			text: `Started ${format.toUpperCase()} recording ${recording.id} for ${session.id}/${tabId}; stop it with record_stop. Output: ${this.displayPath(outputPath)}.`,
			details: {
				action: "record_start",
				recordingId: recording.id,
				sessionId: session.id,
				tabId,
				path: outputPath,
				format,
				fps,
			},
		};
	}

	private async recordStop(input: BrowserToolInput): Promise<ToolResponse> {
		const recording = this.resolveRecording(input.recordingId, input.sessionId, input.tabId);
		await this.stopRecording(recording);
		this.recordings.delete(recording.id);

		const elapsedMs = Date.now() - recording.startedAt;
		const durationMs = Math.round((recording.frameCount / recording.fps) * 1000);
		if (recording.exitCode && recording.exitCode !== 0) {
			throw new Error(`Recording ${recording.id} failed with ffmpeg exit code ${recording.exitCode}: ${recording.stderr || "no ffmpeg stderr"}`);
		}

		return {
			text: `Saved recording ${recording.id} to ${this.displayPath(recording.outputPath)} (${recording.frameCount} frames, ${(durationMs / 1000).toFixed(1)}s video, ${(elapsedMs / 1000).toFixed(1)}s elapsed).`,
			details: {
				action: "record_stop",
				recordingId: recording.id,
				sessionId: recording.sessionId,
				tabId: recording.tabId,
				path: recording.outputPath,
				format: recording.format,
				fps: recording.fps,
				frameCount: recording.frameCount,
				durationMs,
				elapsedMs,
			},
		};
	}

	private async workflowRecordStart(input: BrowserToolInput): Promise<ToolResponse> {
		const activeRecording = [...this.workflowRecordings.values()].find((recording) => recording.active);
		if (activeRecording) {
			throw new Error(`Workflow recording '${activeRecording.name}' is already active as ${activeRecording.id}; stop it with workflow_record_stop before starting another.`);
		}

		let session: BrowserSessionRecord;
		let openedSession = false;
		try {
			session = this.resolveSession(input.sessionId);
		} catch (error) {
			if (input.sessionId) throw error;
			await this.start({
				action: "start",
				browserKey: input.browserKey,
				profile: input.profile,
				url: input.url,
				headless: input.headless,
				executablePath: input.executablePath,
				waitUntil: input.waitUntil,
				timeoutMs: input.timeoutMs,
			});
			session = this.resolveSession();
			openedSession = true;
		}
		const page = await this.resolvePage(session, input.tabId);
		const tabId = session.currentPageId;
		if (!tabId) throw new Error("No tab is active to record a workflow.");

		const name = input.workflowName?.trim() || `Workflow ${new Date().toLocaleString()}`;
		const recordingNumber = this.nextWorkflowRecordingNumber++;
		const recordingId = `workflow-recording-${recordingNumber}`;
		const recording: WorkflowRecordingRecord = {
			id: recordingId,
			name,
			sessionId: session.id,
			tabId,
			page,
			browserKey: session.browserKey,
			profile: session.profile,
			startedAt: Date.now(),
			steps: [],
			active: true,
		};

		this.workflowRecordings.set(recording.id, recording);
		await mkdir(this.workflowRoot(), { recursive: true });
		await page.removeExposedFunction(WORKFLOW_RECORDER_FUNCTION).catch(() => undefined);
		await page.exposeFunction(WORKFLOW_RECORDER_FUNCTION, (payload: Record<string, unknown>) => {
			this.recordWorkflowBrowserEvent(recording.id, payload);
		});
		if (!this.workflowRecorderInjectedPages.has(page)) {
			await page.evaluateOnNewDocument(injectedWorkflowRecorder, WORKFLOW_RECORDER_FUNCTION);
			this.workflowRecorderInjectedPages.add(page);
		}
		await page.evaluate(injectedWorkflowRecorder, WORKFLOW_RECORDER_FUNCTION).catch(() => undefined);

		const currentUrl = page.url();
		if (currentUrl && currentUrl !== "about:blank") {
			recording.steps.push({ type: "navigate", url: currentUrl, timestamp: Date.now() });
		}

		return {
			text: `${openedSession ? `Started ${session.displayName} as ${session.id} and ` : ""}Started workflow recording ${recording.id} for ${session.id}/${tabId}. Interact with the page, then stop it with workflow_record_stop.`,
			details: {
				action: "workflow_record_start",
				workflowRecordingId: recording.id,
				name,
				sessionId: session.id,
				tabId,
				activeRecording: {
					id: recording.id,
					name: recording.name,
					sessionId: session.id,
					tabId,
					stepCount: recording.steps.length,
					startedAt: recording.startedAt,
				},
			},
		};
	}

	private async workflowRecordStop(input: BrowserToolInput): Promise<ToolResponse> {
		const recording = this.resolveWorkflowRecording(input.workflowRecordingId, input.sessionId, input.tabId);
		await this.stopWorkflowRecording(recording);
		this.workflowRecordings.delete(recording.id);

		const now = new Date().toISOString();
		const workflow: SavedWorkflow = {
			schemaVersion: 1,
			id: createWorkflowId(input.workflowName?.trim() || recording.name),
			name: input.workflowName?.trim() || recording.name,
			createdAt: now,
			updatedAt: now,
			browserKey: recording.browserKey,
			profile: recording.profile,
			steps: recording.steps,
		};
		const saved = await writeWorkflow(this.workflowRoot(), workflow);
		const elapsedMs = Date.now() - recording.startedAt;

		return {
			text: `Saved workflow '${workflow.name}' (${workflow.steps.length} steps, ${(elapsedMs / 1000).toFixed(1)}s) to ${this.displayPath(saved.jsonPath)}.\nGenerated Puppeteer script: ${this.displayPath(saved.scriptPath)}\n\n${truncate(saved.script, 10_000)}`,
			details: {
				action: "workflow_record_stop",
				workflow: summarizeWorkflow(workflow),
				jsonPath: saved.jsonPath,
				scriptPath: saved.scriptPath,
				stepCount: workflow.steps.length,
			},
		};
	}

	private workflowStatus(): ToolResponse {
		const active = [...this.workflowRecordings.values()].map((recording) => ({
			id: recording.id,
			name: recording.name,
			sessionId: recording.sessionId,
			tabId: recording.tabId,
			stepCount: recording.steps.length,
			startedAt: recording.startedAt,
			recentSteps: recording.steps.slice(-8),
		}));
		return {
			text: active.length
				? `Active workflow recordings:\n${active.map((item) => `${item.id}: ${item.name} (${item.stepCount} steps)`).join("\n")}`
				: "No workflow recordings are active.",
			details: { action: "workflow_status", active },
		};
	}

	private async workflowList(): Promise<ToolResponse> {
		const workflows = await listWorkflows(this.workflowRoot());
		return {
			text: workflows.length
				? `Saved workflows:\n${workflows.map((workflow) => `${workflow.id}: ${workflow.name} (${workflow.stepCount} steps)`).join("\n")}`
				: "No saved workflows.",
			details: { action: "workflow_list", workflows },
		};
	}

	private async workflowReplay(input: BrowserToolInput): Promise<ToolResponse> {
		const workflow = await this.resolveWorkflow(input);
		let session: BrowserSessionRecord;
		try {
			session = this.resolveSession(input.sessionId);
		} catch {
			await this.start({ action: "start", browserKey: input.browserKey ?? workflow.browserKey, profile: input.profile ?? workflow.profile, headless: input.headless });
			session = this.resolveSession();
		}
		const page = await this.resolvePage(session, input.tabId);
		for (const step of workflow.steps) {
			await this.replayWorkflowStep(page, step, input.timeoutMs ?? this.config.defaults.timeoutMs);
		}
		return {
			text: `Replayed workflow '${workflow.name}' (${workflow.steps.length} steps) in ${session.id}/${session.currentPageId}.`,
			details: { action: "workflow_replay", workflow: summarizeWorkflow(workflow), sessionId: session.id, tabId: session.currentPageId },
		};
	}

	private async workflowDetails(input: BrowserToolInput): Promise<ToolResponse> {
		const workflow = await this.resolveWorkflow(input);
		const calls = generateBrowserToolCalls(workflow);
		const visitedUrls = [...new Set(workflow.steps
			.flatMap((step) => {
				if (step.type === "navigate") return [step.url];
				if ("url" in step && typeof step.url === "string" && step.url) return [step.url];
				return [] as string[];
			})
			.filter((url) => url && url !== "about:blank"))];
		const urlSummary = visitedUrls.length
			? `Visited URL${visitedUrls.length === 1 ? "" : "s"}:\n${visitedUrls.map((url, index) => `${index + 1}. ${url}`).join("\n")}`
			: "Visited URL: not captured";

		let currentUrl = "";
		const callsWithContext = calls.map((call, index) => {
			const step = workflow.steps[index];
			const stepUrl = step
				? (step.type === "navigate"
					? step.url
					: ("url" in step && typeof step.url === "string" ? step.url : undefined))
				: undefined;
			if (stepUrl && stepUrl !== "about:blank") currentUrl = stepUrl;
			return {
				index: index + 1,
				url: currentUrl || null,
				call,
			};
		});
		const actionLines = callsWithContext.map((item) => `${item.index}. [${item.url ?? "url-not-captured"}] ${JSON.stringify(item.call)}`);

		return {
			text: `Workflow '${workflow.name}' has ${workflow.steps.length} steps.\n${urlSummary}\nRaw browser action fallback sequence (ordered with URL context):\n${truncate(actionLines.join("\n"), 10_000)}`,
			details: {
				action: "workflow_details",
				workflow: summarizeWorkflow(workflow),
				steps: workflow.steps,
				calls,
				callsWithContext,
			},
		};
	}

	private async workflowRename(input: BrowserToolInput): Promise<ToolResponse> {
		if (!input.targetWorkflowName?.trim()) throw new Error("targetWorkflowName is required for workflow_rename.");
		const workflow = await renameWorkflow(this.workflowRoot(), this.workflowIdentifier(input), input.targetWorkflowName);
		return {
			text: `Renamed workflow to '${workflow.name}' (${workflow.id}).`,
			details: { action: "workflow_rename", workflow: summarizeWorkflow(workflow) },
		};
	}

	private async workflowDelete(input: BrowserToolInput): Promise<ToolResponse> {
		const workflow = await deleteWorkflow(this.workflowRoot(), this.workflowIdentifier(input));
		return {
			text: `Deleted workflow '${workflow.name}' (${workflow.id}).`,
			details: { action: "workflow_delete", workflow: summarizeWorkflow(workflow) },
		};
	}

	private async workflowExport(input: BrowserToolInput): Promise<ToolResponse> {
		const workflow = await this.resolveWorkflow(input);
		const format = input.scriptFormat ?? "puppeteer";
		const script = format === "browser_tool" ? generateBrowserToolScript(workflow) : generatePuppeteerScript(workflow);
		const defaultFileName = format === "browser_tool"
			? `${sanitizeWorkflowSegment(workflow.id, "workflow")}.browser-tool.js`
			: `${sanitizeWorkflowSegment(workflow.id, "workflow")}.js`;
		const outputPath = input.path
			? resolve(this.cwd, input.path)
			: resolve(this.workflowRoot(), defaultFileName);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, script, "utf8");
		const fileUrl = pathToFileURL(outputPath).href;
		return {
			text: `Script exported to ${fileUrl}\nLocal path: ${outputPath}`,
			details: { action: "workflow_export", workflow: summarizeWorkflow(workflow), format, path: outputPath, fileUrl, script },
		};
	}

	private async replayWorkflowStep(page: Page, step: WorkflowStep, timeoutMs: number): Promise<void> {
		await this.ensureWorkflowStepUrl(page, step, timeoutMs);
		switch (step.type) {
			case "navigate":
				await page.goto(step.url, { waitUntil: this.config.defaults.navigationWaitUntil, timeout: timeoutMs });
				return;
			case "click":
				await page.click(await findFirstSelector(page, step.selectors, timeoutMs));
				await this.settleWorkflowStep(page, timeoutMs);
				return;
			case "change": {
				const selector = await findFirstSelector(page, step.selectors, timeoutMs);
				const editable = await page.$eval(selector, (node) => {
					if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
					if (!(node instanceof HTMLInputElement)) return false;
					return !["hidden", "button", "submit", "reset", "image", "file", "checkbox", "radio"].includes(node.type);
				});
				if (!editable) return;
				await page.focus(selector);
				await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
				await page.keyboard.press("A");
				await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
				await page.keyboard.press("Backspace");
				if (step.value && step.value !== "<redacted>") await page.type(selector, step.value);
				return;
			}
			case "keyDown":
				await page.keyboard.press(step.key as Parameters<typeof page.keyboard.press>[0]);
				await this.settleWorkflowStep(page, timeoutMs);
				return;
			case "scroll":
				await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: step.x, y: step.y });
				return;
			case "submit": {
				const selector = await findFirstSelector(page, step.selectors, timeoutMs);
				await page.$eval(selector, (node) => {
					const form = node instanceof HTMLFormElement ? node : node.closest("form");
					form?.requestSubmit();
				});
				await this.settleWorkflowStep(page, timeoutMs);
				return;
			}
			case "waitForElement":
				await page.waitForSelector(await findFirstSelector(page, step.selectors, timeoutMs), { timeout: timeoutMs });
				return;
		}
	}

	private async ensureWorkflowStepUrl(page: Page, step: WorkflowStep, timeoutMs: number): Promise<void> {
		if (step.type === "navigate" || !("url" in step) || !step.url || step.url === "about:blank") return;
		const currentUrl = page.url();
		if (currentUrl === step.url) return;
		if (currentUrl === "about:blank") {
			await page.goto(step.url, { waitUntil: this.config.defaults.navigationWaitUntil, timeout: timeoutMs });
			return;
		}
		try {
			const current = new URL(currentUrl);
			const target = new URL(step.url);
			if (current.origin !== target.origin || current.pathname !== target.pathname) {
				await page.goto(step.url, { waitUntil: this.config.defaults.navigationWaitUntil, timeout: timeoutMs });
			}
		} catch {
			// Ignore non-standard URLs; selector lookup will surface a useful error if replay cannot continue.
		}
	}

	private async settleWorkflowStep(page: Page, timeoutMs: number): Promise<void> {
		await Promise.race([
			page.waitForNavigation({ waitUntil: this.config.defaults.navigationWaitUntil, timeout: Math.min(timeoutMs, 5000) }).catch(() => undefined),
			new Promise((resolve) => setTimeout(resolve, 250)),
		]);
	}

	private recordWorkflowBrowserEvent(recordingId: string, payload: Record<string, unknown>): void {
		const recording = this.workflowRecordings.get(recordingId);
		if (!recording?.active) return;
		const type = payload.type;
		const timestamp = typeof payload.timestamp === "number" ? payload.timestamp : Date.now();
		const url = typeof payload.url === "string" ? payload.url : undefined;
		const selectors = this.normalizeWorkflowSelectors(payload.selectors);

		if (type === "change" && selectors) {
			const value = typeof payload.value === "string" ? payload.value : "";
			const key = JSON.stringify(selectors);
			const previous = recording.steps.at(-1);
			if (previous?.type === "change" && recording.lastChangeKey === key) {
				previous.value = value;
				previous.timestamp = timestamp;
				return;
			}
			recording.lastChangeKey = key;
			recording.steps.push({ type: "change", selectors, value, url, timestamp });
			return;
		}

		recording.lastChangeKey = undefined;
		if (type === "click" && selectors) {
			recording.steps.push({ type: "click", selectors, button: typeof payload.button === "number" ? payload.button : undefined, url, timestamp });
			return;
		}
		if (type === "submit" && selectors) {
			recording.steps.push({ type: "submit", selectors, url, timestamp });
			return;
		}
		if (type === "keyDown" && typeof payload.key === "string") {
			recording.steps.push({ type: "keyDown", key: payload.key, url, timestamp });
			return;
		}
		if (type === "scroll" && typeof payload.x === "number" && typeof payload.y === "number") {
			if (recording.lastScrollAt && timestamp - recording.lastScrollAt < 300) return;
			recording.lastScrollAt = timestamp;
			recording.steps.push({ type: "scroll", x: payload.x, y: payload.y, url, timestamp });
		}
	}

	private recordWorkflowStep(sessionId: string, tabId: string | undefined, step: WorkflowStep): void {
		if (!tabId) return;
		for (const recording of this.workflowRecordings.values()) {
			if (!recording.active || recording.sessionId !== sessionId || recording.tabId !== tabId) continue;
			recording.lastChangeKey = undefined;
			recording.steps.push(step);
		}
	}

	private normalizeWorkflowSelectors(value: unknown): string[][] | undefined {
		if (!Array.isArray(value)) return undefined;
		const selectors = value
			.filter((group): group is unknown[] => Array.isArray(group))
			.map((group) => group.filter((selector): selector is string => typeof selector === "string" && selector.length > 0));
		return selectors.length ? selectors : undefined;
	}

	private resolveWorkflowRecording(recordingId?: string, sessionId?: string, tabId?: string): WorkflowRecordingRecord {
		if (recordingId) {
			const recording = this.workflowRecordings.get(recordingId);
			if (!recording) throw new Error(`Unknown workflow recording: ${recordingId}`);
			return recording;
		}
		const candidates = [...this.workflowRecordings.values()].filter((recording) => {
			if (!recording.active) return false;
			if (sessionId && recording.sessionId !== sessionId) return false;
			if (tabId && recording.tabId !== tabId) return false;
			return true;
		});
		if (!candidates.length) throw new Error("No active workflow recording matched the requested session/tab.");
		if (candidates.length > 1) throw new Error(`Multiple workflow recordings matched; pass workflowRecordingId (${candidates.map((recording) => recording.id).join(", ")}).`);
		return candidates[0]!;
	}

	private async stopWorkflowRecording(recording: WorkflowRecordingRecord): Promise<void> {
		recording.active = false;
		if (recording.page.isClosed()) return;
		await recording.page.removeExposedFunction(WORKFLOW_RECORDER_FUNCTION).catch(() => undefined);
	}

	private async resolveWorkflow(input: BrowserToolInput): Promise<SavedWorkflow> {
		return readWorkflow(this.workflowRoot(), this.workflowIdentifier(input));
	}

	private workflowIdentifier(input: BrowserToolInput): string {
		const identifier = input.workflowId ?? input.workflowName;
		if (!identifier?.trim()) throw new Error("workflowId or workflowName is required.");
		return identifier.trim();
	}

	private workflowRoot(): string {
		return workflowRoot(this.config.artifactRoot);
	}

	private async registerSession(input: {
		browser: Browser;
		browserKey: string;
		displayName: string;
		engine: "chromium" | "firefox";
		mode: "launch" | "attach";
		profile?: string;
		dispose?: () => Promise<void>;
	}): Promise<BrowserSessionRecord> {
		const session: BrowserSessionRecord = {
			id: `session-${this.nextSessionNumber++}`,
			browserKey: input.browserKey,
			displayName: input.displayName,
			engine: input.engine,
			mode: input.mode,
			profile: input.profile,
			browser: input.browser,
			pages: new Map<string, Page>(),
			currentPageId: undefined,
			nextTabNumber: 1,
			createdAt: Date.now(),
			dispose: input.dispose,
		};
		this.sessions.set(session.id, session);
		this.currentSessionId = session.id;
		const pages = await input.browser.pages();
		if (!pages.length) {
			await input.browser.newPage();
		}
		await this.syncPages(session);
		return session;
	}

	private async syncPages(session: BrowserSessionRecord): Promise<PageRecord[]> {
		const openPages = (await session.browser.pages()).filter((page) => !page.isClosed());
		const next = new Map<string, Page>();

		for (const page of openPages) {
			const existing = [...session.pages.entries()].find(([, known]) => known === page)?.[0];
			const id = existing ?? `tab-${session.nextTabNumber++}`;
			next.set(id, page);
		}

		session.pages = next;
		if (!session.currentPageId || !session.pages.has(session.currentPageId)) {
			session.currentPageId = session.pages.keys().next().value;
		}

		return Promise.all(
			[...session.pages.entries()].map(async ([id, page]) => ({
				id,
				url: page.url(),
				title: await page.title().catch(() => ""),
				current: id === session.currentPageId,
			})),
		);
	}

	private resolveBrowserKey(browserKey?: string): string {
		if (!browserKey) return this.config.defaultBrowser;
		return browserKey === "system" ? this.config.systemDefaultBrowser : browserKey;
	}

	private resolveSession(sessionId?: string): BrowserSessionRecord {
		const resolvedId = sessionId ?? this.currentSessionId;
		if (!resolvedId) {
			throw new Error("No browser session is active. Start or attach to a browser first.");
		}
		const session = this.sessions.get(resolvedId);
		if (!session) {
			throw new Error(`Unknown browser session: ${resolvedId}`);
		}
		return session;
	}

	private async resolvePage(session: BrowserSessionRecord, tabId?: string): Promise<Page> {
		await this.syncPages(session);
		const resolvedTabId = tabId ?? session.currentPageId;
		if (!resolvedTabId) {
			const page = await session.browser.newPage();
			await this.syncPages(session);
			return page;
		}
		const page = session.pages.get(resolvedTabId);
		if (!page) {
			throw new Error(`Unknown tab '${resolvedTabId}' in ${session.id}.`);
		}
		session.currentPageId = resolvedTabId;
		return page;
	}

	private async stopSession(session: BrowserSessionRecord): Promise<void> {
		await this.stopSessionRecordings(session.id);
		await this.stopSessionWorkflowRecordings(session.id);
		if (session.mode === "attach") {
			session.browser.disconnect();
			return;
		}
		if (session.dispose) {
			await session.dispose();
			return;
		}
		await session.browser.close();
	}

	private async summarizeSession(session: BrowserSessionRecord): Promise<SessionSummary> {
		await this.syncPages(session);
		return {
			id: session.id,
			browserKey: session.browserKey,
			displayName: session.displayName,
			engine: session.engine,
			mode: session.mode,
			profile: session.profile,
			current: session.id === this.currentSessionId,
			currentTabId: session.currentPageId,
			tabCount: session.pages.size,
		};
	}

	private resolveRecordingFormat(input: BrowserToolInput): RecordingFormat {
		if (input.format) return input.format;
		const extension = extname(input.path ?? "").toLowerCase();
		if (extension === ".gif") return "gif";
		if (extension === ".webm") return "webm";
		return "mp4";
	}

	private ffmpegArgs(format: RecordingFormat, fps: number, outputPath: string): string[] {
		const args = ["-y", "-f", "image2pipe", "-vcodec", "png", "-framerate", String(fps), "-i", "pipe:0", "-an"];
		if (format === "gif") {
			return [...args, "-vf", `fps=${fps},scale=iw:-1:flags=lanczos`, outputPath];
		}
		const evenDimensions = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
		if (format === "webm") {
			return [...args, "-vf", evenDimensions, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "0", "-crf", "34", outputPath];
		}
		return [...args, "-vf", evenDimensions, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath];
	}

	private waitForSpawn(process: RecordingRecord["process"], ffmpegPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			process.once("spawn", resolve);
			process.once("error", (error) => {
				reject(new Error(`Failed to start ffmpeg (${ffmpegPath}). Install ffmpeg or pass ffmpegPath. ${(error as Error).message}`));
			});
		});
	}

	private async captureRecordingFrame(recording: RecordingRecord): Promise<void> {
		if (!recording.active || recording.busy || recording.page.isClosed()) return;
		recording.busy = true;
		try {
			const frame = await recording.page.screenshot({ type: "png", encoding: "binary" });
			const stdin = recording.process.stdin;
			if (!stdin?.writable) return;
			if (!stdin.write(frame)) {
				await new Promise<void>((resolve) => stdin.once("drain", resolve));
			}
			recording.frameCount += 1;
		} catch (error) {
			recording.stderr = truncate(`${recording.stderr}\n${(error as Error).message}`, 5000);
		} finally {
			recording.busy = false;
		}
	}

	private resolveRecording(recordingId?: string, sessionId?: string, tabId?: string): RecordingRecord {
		if (recordingId) {
			const recording = this.recordings.get(recordingId);
			if (!recording) throw new Error(`Unknown recording: ${recordingId}`);
			return recording;
		}

		const candidates = [...this.recordings.values()].filter((recording) => {
			if (!recording.active) return false;
			if (sessionId && recording.sessionId !== sessionId) return false;
			if (tabId && recording.tabId !== tabId) return false;
			return true;
		});
		if (!candidates.length) throw new Error("No active recording matched the requested session/tab.");
		if (candidates.length > 1) {
			throw new Error(`Multiple active recordings matched; pass recordingId (${candidates.map((recording) => recording.id).join(", ")}).`);
		}
		return candidates[0]!;
	}

	private async stopSessionRecordings(sessionId: string, tabId?: string): Promise<void> {
		const recordings = [...this.recordings.values()].filter((recording) => {
			if (recording.sessionId !== sessionId) return false;
			if (tabId && recording.tabId !== tabId) return false;
			return true;
		});
		for (const recording of recordings) {
			await this.stopRecording(recording).catch(() => undefined);
			this.recordings.delete(recording.id);
		}
	}

	private async stopSessionWorkflowRecordings(sessionId: string, tabId?: string): Promise<void> {
		const recordings = [...this.workflowRecordings.values()].filter((recording) => {
			if (recording.sessionId !== sessionId) return false;
			if (tabId && recording.tabId !== tabId) return false;
			return true;
		});
		for (const recording of recordings) {
			await this.stopWorkflowRecording(recording).catch(() => undefined);
			this.workflowRecordings.delete(recording.id);
		}
	}

	private async stopRecording(recording: RecordingRecord): Promise<void> {
		recording.active = false;
		clearInterval(recording.timer);
		while (recording.busy) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (recording.process.exitCode !== null) {
			recording.exitCode = recording.process.exitCode;
			return;
		}
		recording.process.stdin?.end();
		let timedOut = false;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				timedOut = true;
				recording.process.kill("SIGKILL");
				resolve();
			}, 10_000);
			recording.process.once("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		recording.exitCode = timedOut ? -1 : recording.process.exitCode;
	}

	private displayPath(path: string): string {
		const rel = relative(this.cwd, path);
		return rel && !rel.startsWith("..") ? rel : path;
	}
}
