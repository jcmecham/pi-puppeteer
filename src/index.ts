import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { BrowserManager } from "./manager.ts";
import type { BrowserToolInput, RawExtensionConfig, ResolvedConfig, SessionSummary, WorkflowStep } from "./types.ts";

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

interface WorkflowStatusUiContext {
	ui: {
		theme: { fg: (...args: any[]) => string };
		setStatus: (key: string, value: string | undefined) => void;
		setWidget?: (key: string, value: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
	};
}

interface ActiveWorkflowRecording {
	id: string;
	name: string;
	sessionId?: string;
	tabId?: string;
	stepCount: number;
	startedAt: number;
	recentSteps?: WorkflowStep[];
}

interface SavedWorkflowSummary {
	id: string;
	name: string;
	stepCount: number;
	startUrl: string | null;
}

type WorkflowLibraryAction =
	| { type: "exit" }
	| { type: "start" }
	| { type: "replay"; workflow: SavedWorkflowSummary }
	| { type: "rename"; workflow: SavedWorkflowSummary }
	| { type: "export"; workflow: SavedWorkflowSummary }
	| { type: "delete"; workflow: SavedWorkflowSummary };

type SessionManagerAction =
	| { type: "exit" }
	| { type: "create" }
	| { type: "activate"; session: SessionSummary }
	| { type: "close"; session: SessionSummary };

const WORKFLOW_RECORDING_WIDGET_KEY = "pi-puppeteer-workflow-recording";
const WORKFLOW_RECORDING_STATUS_KEY = "pi-puppeteer-workflow";
const BROWSER_SESSIONS_STATUS_KEY = "pi-puppeteer-sessions";
const BROWSER_SESSIONS_WIDGET_KEY = "pi-puppeteer-sessions-widget";

function recordingDot(ctx: WorkflowStatusUiContext, lit = true): string {
	return ctx.ui.theme.fg(lit ? "error" : "dim", lit ? "●" : "○");
}

function setWorkflowRecordingStatus(ctx: WorkflowStatusUiContext, _active?: { id?: string; name?: string }, _lit = true): void {
	// Recording state is shown above the editor. Keep the footer/status line quiet.
	ctx.ui.setStatus(WORKFLOW_RECORDING_STATUS_KEY, undefined);
}

function setWorkflowRecordingWidget(ctx: WorkflowStatusUiContext, active?: ActiveWorkflowRecording, lit = true): void {
	if (!ctx.ui.setWidget) return;
	if (!active) {
		ctx.ui.setWidget(WORKFLOW_RECORDING_WIDGET_KEY, undefined);
		return;
	}

	const actionLabel = `${active.stepCount} action${active.stepCount === 1 ? "" : "s"}`;
	const name = active.name || active.id || "workflow";
	const line = [
		`${recordingDot(ctx, lit)} ${ctx.ui.theme.fg("text", `Recording ${name}`)}`,
		ctx.ui.theme.fg("muted", `${actionLabel} · ${formatElapsed(active.startedAt)}`),
		ctx.ui.theme.fg("dim", "[Alt+R] expand · [Alt+S] stop/save"),
	].join(ctx.ui.theme.fg("dim", "  ·  "));
	ctx.ui.setWidget(WORKFLOW_RECORDING_WIDGET_KEY, [line], { placement: "aboveEditor" });
}

function workflowPickerTitle(ctx: WorkflowStatusUiContext, active?: { id?: string; name?: string }, lit = true): string {
	return active ? `${recordingDot(ctx, lit)} Recording Workflow: ${active.name || active.id || "workflow"}` : "Workflows:";
}

function formatElapsed(startedAt?: number): string {
	if (!startedAt) return "0s";
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function workflowSelectorPreview(selectors: string[][]): string {
	const selector = selectors.flat().find(Boolean) ?? "target";
	return selector.length > 48 ? `${selector.slice(0, 45)}…` : selector;
}

function workflowStepLabel(step: WorkflowStep): string {
	switch (step.type) {
		case "navigate":
			return `Open ${step.url}`;
		case "click":
			return `Click ${workflowSelectorPreview(step.selectors)}`;
		case "change":
			return `Type ${step.value === "<redacted>" ? "redacted text" : `${step.value.length} chars`} into ${workflowSelectorPreview(step.selectors)}`;
		case "keyDown":
			return `Press ${step.key}`;
		case "scroll":
			return `Scroll to ${Math.round(step.x)}, ${Math.round(step.y)}`;
		case "submit":
			return `Submit ${workflowSelectorPreview(step.selectors)}`;
		case "waitForElement":
			return `Wait for ${workflowSelectorPreview(step.selectors)}`;
	}
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function truncateAnsi(value: string, width: number): string {
	if (width <= 0) return "";
	if (stripAnsi(value).length <= width) return value;
	let visible = 0;
	let output = "";
	for (let index = 0; index < value.length;) {
		if (value[index] === "\x1b") {
			const match = value.slice(index).match(/^\x1B\[[0-?]*[ -/]*[@-~]/);
			if (match) {
				output += match[0];
				index += match[0].length;
				continue;
			}
		}
		if (visible >= width - 1) break;
		output += value[index];
		visible += 1;
		index += 1;
	}
	return `${output}…`;
}

function padAnsiEnd(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - stripAnsi(value).length))}`;
}

function joinColumns(left: string, right: string, width: number): string {
	const rightWidth = stripAnsi(right).length;
	const leftWidth = Math.max(0, width - rightWidth - 1);
	const renderedLeft = truncateAnsi(left, leftWidth);
	return `${renderedLeft}${" ".repeat(Math.max(1, width - stripAnsi(renderedLeft).length - rightWidth))}${right}`;
}

function workflowRecentActionLines(steps: WorkflowStep[], hiddenCount: number): string[] {
	const lines: string[] = [];
	for (let index = 0; index < steps.length;) {
		const step = steps[index]!;
		const stepNumber = hiddenCount + index + 1;
		if (step.type === "scroll") {
			let end = index;
			while (end + 1 < steps.length && steps[end + 1]!.type === "scroll") end += 1;
			const last = steps[end] as typeof step;
			const label = end === index
				? `${stepNumber}. Scroll to y=${Math.round(step.y)}`
				: `${stepNumber}–${hiddenCount + end + 1}. Scroll page, y=${Math.round(step.y)} → y=${Math.round(last.y)}`;
			lines.push(label);
			index = end + 1;
			continue;
		}

		const label = workflowStepLabel(step);
		let end = index;
		while (end + 1 < steps.length && steps[end + 1]!.type !== "scroll" && workflowStepLabel(steps[end + 1]!) === label) end += 1;
		lines.push(end === index ? `${stepNumber}. ${label}` : `${stepNumber}–${hiddenCount + end + 1}. ${label}`);
		index = end + 1;
	}
	return lines;
}

function styledRecordingDot(theme: { fg: (color: any, text: string) => string }, lit = true): string {
	return theme.fg(lit ? "error" : "dim", lit ? "●" : "○");
}

type RecordingScreenComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
};

async function showWorkflowRecordingScreen(
	ctx: ExtensionContext,
	browserManager: BrowserManager,
	initialRecording: ActiveWorkflowRecording,
): Promise<"stop" | "background"> {
	let activeRecording: ActiveWorkflowRecording | undefined = initialRecording;
	let lit = true;
	let component: RecordingScreenComponent | undefined;
	let requestRender: (() => void) | undefined;
	let busy = false;

	const refresh = async () => {
		if (busy) return;
		busy = true;
		try {
			const refreshed = await browserManager.execute({ action: "workflow_status" });
			const [current] = ((refreshed.details.active as ActiveWorkflowRecording[] | undefined) ?? []);
			activeRecording = current;
			lit = !lit;
			setWorkflowRecordingStatus(ctx, current, lit);
			component?.invalidate();
			requestRender?.();
		} finally {
			busy = false;
		}
	};

	const timer = setInterval(() => void refresh(), 500);
	try {
		return await ctx.ui.custom<"stop" | "background">((tui, theme, _keybindings, done) => {
			requestRender = () => tui.requestRender();
			component = {
				render(width: number): string[] {
					const recording = activeRecording ?? initialRecording;
					const recentSteps = recording.recentSteps ?? [];
					const hiddenCount = Math.max(0, recording.stepCount - recentSteps.length);
					const bold = (text: string) => ("bold" in theme && typeof theme.bold === "function" ? theme.bold(text) : text);
					const minWidth = Math.max(24, width);
					const innerWidth = Math.max(1, minWidth - 4);
					const border = (left: string, fill: string, right: string) => theme.fg("borderMuted", `${left}${fill.repeat(Math.max(0, minWidth - 2))}${right}`);
					const boxed = (content: string) => `${theme.fg("borderMuted", "│ ")}${padAnsiEnd(truncateAnsi(content, innerWidth), innerWidth)}${theme.fg("borderMuted", " │")}`;
					const target = recording.sessionId && recording.tabId ? `${recording.sessionId}/${recording.tabId}` : "browser page";
					const lines = [
						border("╭", "─", "╮"),
						boxed(joinColumns(`${styledRecordingDot(theme, lit)} ${bold(`Recording workflow: ${recording.name || recording.id}`)}`, theme.fg("muted", formatElapsed(recording.startedAt)), innerWidth)),
						boxed(theme.fg("dim", target)),
					];

					if (recentSteps.length) {
						lines.push(boxed(""));
						lines.push(boxed(theme.fg("dim", hiddenCount ? `Actions (${recording.stepCount}, ${hiddenCount} earlier)` : `Actions (${recording.stepCount})`)));
						for (const line of workflowRecentActionLines(recentSteps, hiddenCount).slice(-5)) {
							lines.push(boxed(`  ${theme.fg("dim", line)}`));
						}
					}

					const keycap = (label: string, color: "error" | "dim" = "dim") => theme.fg(color, `[${label}]`);
					const controls = [
						`${keycap("Enter", "error")} ${bold("Stop and save")}`,
						`${keycap("Esc")} Collapse`,
					].join(theme.fg("dim", "  ·  "));
					lines.push(
						boxed(""),
						boxed(`${theme.fg("dim", "Controls")}  ${controls}`),
						border("╰", "─", "╯"),
					);
					return lines.map((line) => truncateAnsi(line, width));
				},
				handleInput(data: string): void {
					if (data === "\r" || data === "\n") done("stop");
					if (data === "\x1b") done("background");
				},
				invalidate(): void {},
			};
			return component;
		});
	} finally {
		clearInterval(timer);
		component = undefined;
		requestRender = undefined;
	}
}

function workflowKeycap(theme: { fg: (color: any, text: string) => string }, label: string, color: "accent" | "dim" | "error" | "warning" = "dim"): string {
	return theme.fg(color, `[${label}]`);
}

async function showWorkflowLibraryScreen(
	ctx: ExtensionCommandContext,
	workflows: SavedWorkflowSummary[],
): Promise<WorkflowLibraryAction> {
	let selectedIndex = 0;
	let deleteArmed = false;
	let requestRender: (() => void) | undefined;
	let component: RecordingScreenComponent | undefined;

	return ctx.ui.custom<WorkflowLibraryAction>((tui, theme, _keybindings, done) => {
		requestRender = () => tui.requestRender();
		component = {
			render(width: number): string[] {
				const minWidth = Math.max(24, width);
				const innerWidth = Math.max(1, minWidth - 4);
				const bold = (text: string) => ("bold" in theme && typeof theme.bold === "function" ? theme.bold(text) : text);
				const border = (left: string, fill: string, right: string) => theme.fg("borderMuted", `${left}${fill.repeat(Math.max(0, minWidth - 2))}${right}`);
				const boxed = (content: string) => `${theme.fg("borderMuted", "│ ")}${padAnsiEnd(truncateAnsi(content, innerWidth), innerWidth)}${theme.fg("borderMuted", " │")}`;
				const selected = workflows[selectedIndex];
				const lines = [
					border("╭", "─", "╮"),
					boxed(joinColumns(theme.fg("text", bold("Workflows")), theme.fg("dim", `${workflows.length} saved`), innerWidth)),
					boxed(theme.fg("muted", "A tool for recording browser interactions as workflows you or your agents can replay later.")),
					boxed(""),
				];

				if (!workflows.length) {
					lines.push(boxed(theme.fg("muted", `Press ${workflowKeycap(theme, "N", "accent")} to record browser interactions as a workflow you can replay later.`)));
				} else {
					const maxVisible = 8;
					const visibleCount = Math.min(maxVisible, workflows.length);
					const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), workflows.length - visibleCount));
					const end = start + visibleCount;
					if (start > 0) lines.push(boxed(theme.fg("dim", `  … ${start} earlier`)));
					for (let index = start; index < end; index += 1) {
						const workflow = workflows[index]!;
						const prefix = index === selectedIndex ? theme.fg("accent", "→ ") : "  ";
						const name = index === selectedIndex ? theme.fg("accent", workflow.name) : workflow.name;
						const count = theme.fg("muted", `${workflow.stepCount} step${workflow.stepCount === 1 ? "" : "s"}`);
						lines.push(boxed(`${prefix}${name}  ${count}`));
					}
					if (end < workflows.length) lines.push(boxed(theme.fg("dim", `  … ${workflows.length - end} more`)));
				}

				const controls = !workflows.length
					? [
						`${workflowKeycap(theme, "N", "accent")} Start recording`,
						`${workflowKeycap(theme, "Esc")} Back`,
					].join(theme.fg("dim", "  ·  "))
					: deleteArmed
						? [
							`${workflowKeycap(theme, "D", "warning")} Confirm delete`,
							`${workflowKeycap(theme, "Esc")} Cancel`,
						].join(theme.fg("dim", "  ·  "))
						: [
							`${workflowKeycap(theme, "Enter", "accent")} Replay`,
							`${workflowKeycap(theme, "R", "accent")} Rename`,
							`${workflowKeycap(theme, "E", "accent")} Export`,
							`${workflowKeycap(theme, "D", "accent")} Delete`,
							`${workflowKeycap(theme, "N", "accent")} Start recording`,
							`${workflowKeycap(theme, "Esc")} Back`,
						].join(theme.fg("dim", "  ·  "));
				lines.push(
					boxed(""),
					boxed(`${theme.fg("dim", deleteArmed ? "Delete armed" : "Controls")}  ${controls}`),
					border("╰", "─", "╯"),
				);
				return lines.map((line) => truncateAnsi(line, width));
			},
			invalidate(): void {},
			handleInput(data: string): void {
				const selected = workflows[selectedIndex];
				if (data === "\x1b[A") {
					if (!workflows.length) return;
					selectedIndex = Math.max(0, selectedIndex - 1);
					deleteArmed = false;
					requestRender?.();
					return;
				}
				if (data === "\x1b[B") {
					if (!workflows.length) return;
					selectedIndex = Math.min(workflows.length - 1, selectedIndex + 1);
					deleteArmed = false;
					requestRender?.();
					return;
				}
				if (data === "n" || data === "N") {
					done({ type: "start" });
					return;
				}
				if (data === "\x1b" || data === "\x03") {
					if (deleteArmed) {
						deleteArmed = false;
						requestRender?.();
						return;
					}
					done({ type: "exit" });
					return;
				}
				if (!selected) return;
				if (data === "\r" || data === "\n") {
					done({ type: "replay", workflow: selected });
					return;
				}
				if (data === "r" || data === "R") {
					done({ type: "rename", workflow: selected });
					return;
				}
				if (data === "e" || data === "E") {
					done({ type: "export", workflow: selected });
					return;
				}
				if (data === "d" || data === "D") {
					if (deleteArmed) {
						done({ type: "delete", workflow: selected });
						return;
					}
					deleteArmed = true;
					requestRender?.();
				}
			},
		};
		return component;
	}).finally(() => {
		component = undefined;
		requestRender = undefined;
	});
}

class WorkflowRecordingUiController {
	private activeRecording: ActiveWorkflowRecording | undefined;
	private lit = true;
	private refreshTimer: NodeJS.Timeout | undefined;
	private terminalInputUnsubscribe: (() => void) | undefined;
	private refreshing = false;
	private stopping = false;
	private opening = false;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly getManager: () => BrowserManager,
	) {
		this.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data));
	}

	start(recording: ActiveWorkflowRecording | undefined): void {
		if (!recording) {
			this.clear();
			return;
		}
		this.activeRecording = recording;
		this.renderCollapsed();
		this.ensureRefreshTimer();
	}

	clear(): void {
		this.activeRecording = undefined;
		setWorkflowRecordingStatus(this.ctx, undefined);
		setWorkflowRecordingWidget(this.ctx, undefined);
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	dispose(): void {
		this.clear();
		this.terminalInputUnsubscribe?.();
		this.terminalInputUnsubscribe = undefined;
	}

	async open(): Promise<"stop" | "background" | undefined> {
		if (this.opening || !this.activeRecording) return undefined;
		this.opening = true;
		setWorkflowRecordingWidget(this.ctx, undefined);
		try {
			const choice = await showWorkflowRecordingScreen(this.ctx, this.getManager(), this.activeRecording);
			if (choice === "stop") {
				await this.stopAndSave();
			} else if (this.activeRecording) {
				this.renderCollapsed();
			}
			return choice;
		} finally {
			this.opening = false;
		}
	}

	async stopAndSave(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		try {
			const result = await this.getManager().execute({ action: "workflow_record_stop" });
			this.clear();
			this.ctx.ui.notify(result.text.split("\n", 1)[0] ?? "Workflow saved.", "info");
		} catch (error) {
			this.ctx.ui.notify((error as Error).message, "error");
		} finally {
			this.stopping = false;
		}
	}

	private ensureRefreshTimer(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => void this.refresh(), 500);
	}

	private async refresh(): Promise<void> {
		if (this.refreshing || !this.activeRecording) return;
		this.refreshing = true;
		try {
			const refreshed = await this.getManager().execute({ action: "workflow_status" });
			const [current] = ((refreshed.details.active as ActiveWorkflowRecording[] | undefined) ?? []);
			if (!current) {
				this.clear();
				return;
			}
			this.activeRecording = current;
			this.lit = !this.lit;
			if (!this.opening) this.renderCollapsed();
		} finally {
			this.refreshing = false;
		}
	}

	private renderCollapsed(): void {
		setWorkflowRecordingStatus(this.ctx, this.activeRecording, this.lit);
		setWorkflowRecordingWidget(this.ctx, this.activeRecording, this.lit);
	}

	private handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.activeRecording) return undefined;
		if (data === "\x1br" || data === "\x1bR") {
			void this.open();
			return { consume: true };
		}
		if (data === "\x1bs" || data === "\x1bS") {
			void this.stopAndSave();
			return { consume: true };
		}
		return undefined;
	}
}

function formatRelativeTime(timestamp?: number): string {
	if (!timestamp) return "just now";
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function compactUrl(url?: string): string {
	if (!url) return "(no URL)";
	try {
		const parsed = new URL(url);
		const compact = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
		return compact || url;
	} catch {
		return url;
	}
}

function setBrowserSessionsStatus(ctx: WorkflowStatusUiContext, count: number): void {
	ctx.ui.setStatus(BROWSER_SESSIONS_STATUS_KEY, undefined);
	if (count <= 0) {
		ctx.ui.setWidget?.(BROWSER_SESSIONS_WIDGET_KEY, undefined);
		return;
	}
	if (!ctx.ui.setWidget) {
		const label = ctx.ui.theme.fg("accent", count === 1 ? "Browser Session" : "Browser Sessions");
		const total = ctx.ui.theme.fg("text", `: ${count}`);
		const hint = ctx.ui.theme.fg("dim", " [Alt+P]");
		ctx.ui.setStatus(BROWSER_SESSIONS_STATUS_KEY, `${label}${total}${hint}`);
		return;
	}
	const widgetFactory = ((_tui: any, theme: any) => ({
		render(width: number): string[] {
			const label = theme.fg("accent", count === 1 ? "Browser Session" : "Browser Sessions");
			const total = theme.fg("text", `: ${count}`);
			const hint = theme.fg("dim", " [Alt+P]");
			return [joinColumns("", `${label}${total}${hint}`, width)];
		},
		invalidate(): void {},
	})) as any;
	ctx.ui.setWidget(BROWSER_SESSIONS_WIDGET_KEY, widgetFactory, { placement: "aboveEditor" });
}

async function showBrowserSessionsScreen(
	ctx: ExtensionCommandContext | ExtensionContext,
	sessions: SessionSummary[],
	preferredSessionId?: string,
): Promise<SessionManagerAction> {
	let selectedIndex = Math.max(0, sessions.findIndex((session) => session.id === preferredSessionId || (!preferredSessionId && session.current)));
	let closeArmed = false;
	let requestRender: (() => void) | undefined;
	let component: RecordingScreenComponent | undefined;

	return ctx.ui.custom<SessionManagerAction>((tui, theme, _keybindings, done) => {
		requestRender = () => tui.requestRender();
		component = {
			render(width: number): string[] {
				const minWidth = Math.max(24, width);
				const innerWidth = Math.max(1, minWidth - 4);
				const bold = (text: string) => ("bold" in theme && typeof theme.bold === "function" ? theme.bold(text) : text);
				const border = (left: string, fill: string, right: string) => theme.fg("borderMuted", `${left}${fill.repeat(Math.max(0, minWidth - 2))}${right}`);
				const boxed = (content: string) => `${theme.fg("borderMuted", "│ ")}${padAnsiEnd(truncateAnsi(content, innerWidth), innerWidth)}${theme.fg("borderMuted", " │")}`;
				const selected = sessions[selectedIndex];
				const lines = [
					border("╭", "─", "╮"),
					boxed(theme.fg("text", bold("Browser Manager"))),
					boxed(theme.fg("muted", sessions.length ? "Choose which browser Pi should use by default." : "No browser sessions are open.")),
					boxed(""),
				];

				if (!sessions.length) {
					lines.push(boxed(theme.fg("muted", `Press ${workflowKeycap(theme, "N", "accent")} to open the default browser.`)));
				} else {
					const maxVisible = 4;
					const visibleCount = Math.min(maxVisible, sessions.length);
					const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), sessions.length - visibleCount));
					const end = start + visibleCount;
					lines.push(boxed(theme.fg("dim", "Open browsers")));
					if (start > 0) lines.push(boxed(theme.fg("dim", `  … ${start} earlier`)));
					for (let index = start; index < end; index += 1) {
						const session = sessions[index]!;
						const prefix = index === selectedIndex ? theme.fg("accent", "→ ") : "  ";
						const scope = session.mode === "launch" ? `profile ${session.profile ?? "default"}` : "attached browser";
						const metaBits = [session.id, `${session.tabCount} tab${session.tabCount === 1 ? "" : "s"}`];
						if (session.current) metaBits.push("used by default");
						lines.push(boxed(`${prefix}${theme.fg(index === selectedIndex ? "accent" : "text", `${session.displayName} · ${scope}`)}`));
						lines.push(boxed(`   ${theme.fg("muted", metaBits.join(" · "))}`));
					}
					if (end < sessions.length) lines.push(boxed(theme.fg("dim", `  … ${sessions.length - end} more`)));

					if (selected) {
						const currentTab = selected.tabs.find((tab) => tab.current) ?? selected.tabs[0];
						const currentTitle = currentTab ? currentTab.title || compactUrl(currentTab.url) || "(untitled)" : "No tabs open";
						const currentUrl = currentTab ? compactUrl(currentTab.url) : "";
						const extraTabs = Math.max(0, selected.tabCount - (currentTab ? 1 : 0));
						lines.push(
							boxed(""),
							boxed(theme.fg("dim", "Selected browser")),
							boxed(theme.fg("muted", selected.current ? "Browser commands use this session by default." : `Press ${workflowKeycap(theme, "Enter", "accent")} to use this session by default.`)),
							boxed(`${theme.fg("text", "Browser:")} ${selected.displayName}`),
							boxed(`${theme.fg("text", "Source:")} ${selected.mode === "launch" ? `profile ${selected.profile ?? "default"}` : "attached browser"}`),
							boxed(`${theme.fg("text", "Session:")} ${selected.id}`),
							boxed(`${theme.fg("text", "Current tab:")} ${currentTitle}`),
						);
						if (currentUrl && currentUrl !== currentTitle) {
							lines.push(boxed(theme.fg("muted", currentUrl)));
						}
						if (extraTabs > 0) {
							lines.push(boxed(theme.fg("dim", `${extraTabs} more open tab${extraTabs === 1 ? "" : "s"}`)));
						}
					}
				}

				const stopActionLabel = selected?.mode === "attach" ? "Detach" : "Close";
				const confirmStopActionLabel = selected?.mode === "attach" ? "Confirm detach" : "Confirm close";
				const controls = !sessions.length
					? [
						`${workflowKeycap(theme, "N", "accent")} Open browser`,
						`${workflowKeycap(theme, "Esc")} Back`,
					].join(theme.fg("dim", "  ·  "))
					: closeArmed
						? [
							`${workflowKeycap(theme, "D", "warning")} ${confirmStopActionLabel}`,
							`${workflowKeycap(theme, "Esc")} Cancel`,
						].join(theme.fg("dim", "  ·  "))
						: [
							`${workflowKeycap(theme, "↑↓")} Move`,
							`${workflowKeycap(theme, "Enter", "accent")} ${selected?.current ? "Focus" : "Use by default"}`,
							`${workflowKeycap(theme, "N", "accent")} Open profile`,
							`${workflowKeycap(theme, "D", "accent")} ${stopActionLabel}`,
							`${workflowKeycap(theme, "Esc")} Back`,
						].join(theme.fg("dim", "  ·  "));
				lines.push(
					boxed(""),
					boxed(controls),
					border("╰", "─", "╯"),
				);
				return lines.map((line) => truncateAnsi(line, width));
			},
			invalidate(): void {},
			handleInput(data: string): void {
				const selected = sessions[selectedIndex];
				if (data === "n" || data === "N") {
					done({ type: "create" });
					return;
				}
				if (data === "\x1b[A") {
					if (!sessions.length) return;
					selectedIndex = Math.max(0, selectedIndex - 1);
					closeArmed = false;
					requestRender?.();
					return;
				}
				if (data === "\x1b[B") {
					if (!sessions.length) return;
					selectedIndex = Math.min(sessions.length - 1, selectedIndex + 1);
					closeArmed = false;
					requestRender?.();
					return;
				}
				if (data === "\x1b" || data === "\x03") {
					if (closeArmed) {
						closeArmed = false;
						requestRender?.();
						return;
					}
					done({ type: "exit" });
					return;
				}
				if (!selected) return;
				if (data === "\r" || data === "\n") {
					done({ type: "activate", session: selected });
					return;
				}
				if (data === "d" || data === "D") {
					if (closeArmed) {
						done({ type: "close", session: selected });
						return;
					}
					closeArmed = true;
					requestRender?.();
				}
			},
		};
		return component;
	}).finally(() => {
		component = undefined;
		requestRender = undefined;
	});
}

async function openBrowserSessionsManager(
	ctx: ExtensionCommandContext | ExtensionContext,
	browserManager: BrowserManager,
	onChange?: () => Promise<void>,
): Promise<void> {
	let selectedSessionId: string | undefined;
	while (true) {
		const result = await browserManager.execute({ action: "sessions" });
		const sessions = ((result.details.sessions as SessionSummary[] | undefined) ?? []);
		const action = await showBrowserSessionsScreen(ctx, sessions, selectedSessionId);
		if (action.type === "exit") return;
		if (action.type !== "create") selectedSessionId = action.session.id;
		try {
			if (action.type === "create") {
				let profile: string | undefined;
				if (sessions.length) {
					const suggestedProfile = `profile-${sessions.length + 1}`;
					const enteredProfile = await ctx.ui.input("Profile name for the new browser session:", suggestedProfile);
					if (!enteredProfile) continue;
					const trimmedProfile = enteredProfile.trim();
					if (!trimmedProfile) {
						ctx.ui.notify("Profile name cannot be blank.", "error");
						continue;
					}
					profile = trimmedProfile;
				}
				const started = await browserManager.execute({ action: "start", ...(profile ? { profile } : {}) });
				const session = started.details.session as SessionSummary | undefined;
				selectedSessionId = session?.id;
				ctx.ui.notify(started.text, "info");
			} else if (action.type === "activate") {
				const wasDefault = action.session.current;
				await browserManager.execute({ action: "select_session", sessionId: action.session.id });
				ctx.ui.notify(wasDefault ? `Focused ${action.session.id}.` : `Default session set to ${action.session.id}.`, "info");
			} else if (action.type === "close") {
				const stopped = await browserManager.execute({ action: "stop", sessionId: action.session.id });
				ctx.ui.notify(stopped.text, "info");
			}
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
		}
		await onChange?.();
	}
}

class BrowserSessionsUiController {
	private refreshTimer: NodeJS.Timeout | undefined;
	private terminalInputUnsubscribe: (() => void) | undefined;
	private refreshing = false;
	private opening = false;
	private sessionCount = 0;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly getManager: () => BrowserManager,
	) {
		this.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data));
		this.ensureRefreshTimer();
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		setBrowserSessionsStatus(this.ctx, 0);
		this.terminalInputUnsubscribe?.();
		this.terminalInputUnsubscribe = undefined;
	}

	async refreshNow(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			const result = await this.getManager().execute({ action: "sessions" });
			const sessions = ((result.details.sessions as SessionSummary[] | undefined) ?? []);
			this.sessionCount = sessions.length;
			if (!this.opening) setBrowserSessionsStatus(this.ctx, this.sessionCount);
		} catch {
			this.sessionCount = 0;
			if (!this.opening) setBrowserSessionsStatus(this.ctx, 0);
		} finally {
			this.refreshing = false;
		}
	}

	async open(): Promise<void> {
		if (this.opening) return;
		this.opening = true;
		try {
			await openBrowserSessionsManager(this.ctx, this.getManager(), async () => {
				await this.refreshNow();
			});
		} finally {
			this.opening = false;
			await this.refreshNow();
		}
	}

	private ensureRefreshTimer(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => void this.refreshNow(), 1500);
	}

	private handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (data === "\x1bp" || data === "\x1bP") {
			void this.open();
			return { consume: true };
		}
		return undefined;
	}
}

const BrowserToolSchema = Type.Object({
	action: StringEnum(
		[
			"list_browsers",
			"start",
			"attach",
			"sessions",
			"select_session",
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
			"workflow_record_start",
			"workflow_record_stop",
			"workflow_status",
			"workflow_list",
			"workflow_replay",
			"workflow_details",
			"workflow_rename",
			"workflow_delete",
			"workflow_export",
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
	path: Type.Optional(Type.String({ description: "Output path for screenshots, recordings, or workflow exports" })),
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
	workflowRecordingId: Type.Optional(Type.String({ description: "Workflow recording ID for workflow_record_stop" })),
	workflowId: Type.Optional(Type.String({ description: "Saved workflow ID for workflow_replay, workflow_rename, workflow_delete, or workflow_export" })),
	workflowName: Type.Optional(Type.String({ description: "Workflow name for recording or lookup" })),
	targetWorkflowName: Type.Optional(Type.String({ description: "New workflow name for workflow_rename" })),
	scriptFormat: Type.Optional(StringEnum(["puppeteer", "browser_tool"] as const)),
});

const WorkflowListToolSchema = Type.Object({});

const WorkflowReplayToolSchema = Type.Object({
	workflowId: Type.Optional(Type.String({ description: "Saved workflow ID" })),
	workflowName: Type.Optional(Type.String({ description: "Saved workflow name" })),
	sessionId: Type.Optional(Type.String({ description: "Browser session ID, like session-1" })),
	tabId: Type.Optional(Type.String({ description: "Tab ID, like tab-1" })),
	browserKey: Type.Optional(Type.String({ description: "Browser key used if a new session must be started" })),
	profile: Type.Optional(Type.String({ description: "Profile used if a new session must be started" })),
	headless: Type.Optional(Type.Boolean({ description: "Override launch headless mode for auto-started sessions" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Timeout override in milliseconds" })),
});

const WorkflowDetailsToolSchema = Type.Object({
	workflowId: Type.Optional(Type.String({ description: "Saved workflow ID" })),
	workflowName: Type.Optional(Type.String({ description: "Saved workflow name" })),
});

export default function (pi: ExtensionAPI) {
	let manager: BrowserManager | undefined;
	let workflowUi: WorkflowRecordingUiController | undefined;
	let sessionsUi: BrowserSessionsUiController | undefined;

	pi.on("session_start", async (_event, ctx) => {
		manager = new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
		workflowUi = new WorkflowRecordingUiController(ctx, () => {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			return manager;
		});
		sessionsUi = new BrowserSessionsUiController(ctx, () => {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			return manager;
		});
		await sessionsUi.refreshNow();
	});

	pi.on("session_shutdown", async () => {
		workflowUi?.dispose();
		workflowUi = undefined;
		sessionsUi?.dispose();
		sessionsUi = undefined;
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

	pi.registerCommand("browser", {
		description: "Open the browser manager",
		handler: async (_args, ctx) => {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			await openBrowserSessionsManager(ctx, manager, async () => {
				await sessionsUi?.refreshNow();
			});
		},
	});

	pi.registerCommand("workflows", {
		description: "Open the pi-puppeteer workflow library",
		handler: async (_args, ctx) => {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));

			while (true) {
				const statusResult = await manager.execute({ action: "workflow_status" });
				const activeRecordings = ((statusResult.details.active as ActiveWorkflowRecording[] | undefined) ?? []);
				const activeRecording = activeRecordings[0];
				workflowUi?.start(activeRecording);

				if (activeRecording) {
					const choice = workflowUi ? await workflowUi.open() : await showWorkflowRecordingScreen(ctx, manager, activeRecording);
					if (choice === "background") return;
					if (!workflowUi && choice === "stop") {
						try {
							const result = await manager.execute({ action: "workflow_record_stop" });
							setWorkflowRecordingStatus(ctx, undefined);
							setWorkflowRecordingWidget(ctx, undefined);
							ctx.ui.notify(result.text.split("\n", 1)[0] ?? "Workflow saved.", "info");
						} catch (error) {
							ctx.ui.notify((error as Error).message, "error");
						}
					}
					continue;
				}

				const listResult = await manager.execute({ action: "workflow_list" });
				const workflows = ((listResult.details.workflows as SavedWorkflowSummary[] | undefined) ?? []);
				const action = await showWorkflowLibraryScreen(ctx, workflows);
				if (action.type === "exit") return;

				try {
					if (action.type === "start") {
						const name = await ctx.ui.input("Workflow name:", `Workflow ${new Date().toLocaleString()}`);
						if (!name) continue;
						const result = await manager.execute({ action: "workflow_record_start", workflowName: name });
						const started = result.details.activeRecording as ActiveWorkflowRecording | undefined;
						workflowUi?.start(started);
						if (!workflowUi) {
							setWorkflowRecordingStatus(ctx, started);
							setWorkflowRecordingWidget(ctx, started);
						}
						ctx.ui.notify(result.text, "info");
					} else if (action.type === "replay") {
						const result = await manager.execute({ action: "workflow_replay", workflowId: action.workflow.id });
						ctx.ui.notify(result.text, "info");
					} else if (action.type === "rename") {
						const nextName = await ctx.ui.input("New workflow name:", action.workflow.name);
						if (!nextName) continue;
						const result = await manager.execute({ action: "workflow_rename", workflowId: action.workflow.id, targetWorkflowName: nextName });
						ctx.ui.notify(result.text, "info");
					} else if (action.type === "delete") {
						const result = await manager.execute({ action: "workflow_delete", workflowId: action.workflow.id });
						ctx.ui.notify(result.text, "info");
					} else if (action.type === "export") {
						const result = await manager.execute({ action: "workflow_export", workflowId: action.workflow.id });
						ctx.ui.notify(result.text.split("\n", 1)[0] ?? "Workflow exported.", "info");
					}
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				} finally {
					await sessionsUi?.refreshNow();
				}
			}
		},
	});

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: "Interact with a configured browser session. Supports launch, attach, navigation, clicks, typing, screenshots, text extraction, inspection, ffmpeg-backed page recording, and saved workflow recording/replay.",
		promptSnippet: "Launch or attach to configured browsers, navigate pages, inspect page state, capture screenshots, and record MP4/WebM/GIF clips.",
		promptGuidelines: [
			"Use browser when the user wants Pi to interact with websites, tabs, forms, screenshots, or page inspection.",
			"Use browser start or browser attach before page actions when no browser session is open.",
			"Use browser inspect or browser extract_text instead of dumping large page HTML into context.",
			"Use workflow_list, workflow_replay, and workflow_details for saved workflow execution; use browser workflow_record_start/workflow_record_stop to record new workflows.",
		],
		parameters: BrowserToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			const input = params as BrowserToolInput;
			try {
				const result = await manager.execute(input);
				if (input.action === "workflow_record_start") {
					const activeRecording = result.details.activeRecording as ActiveWorkflowRecording | undefined;
					workflowUi?.start(activeRecording);
					if (!workflowUi) {
						setWorkflowRecordingStatus(ctx, activeRecording);
						setWorkflowRecordingWidget(ctx, activeRecording);
					}
				} else if (input.action === "workflow_record_stop") {
					workflowUi?.clear();
					if (!workflowUi) {
						setWorkflowRecordingStatus(ctx, undefined);
						setWorkflowRecordingWidget(ctx, undefined);
					}
				}
				return {
					content: [{ type: "text", text: result.text }],
					details: result.details,
				};
			} finally {
				await sessionsUi?.refreshNow();
			}
		},
	});

	pi.registerTool({
		name: "workflow_list",
		label: "Workflow List",
		description: "List saved workflows as concise summaries (id, name, step count, and start URL).",
		promptSnippet: "List saved workflows so you can pick one to replay.",
		promptGuidelines: [
			"Use workflow_list before workflow_replay when you do not already know the workflow ID or exact name.",
			"workflow_list returns summaries only; call workflow_details for full step-by-step fallback actions.",
		],
		parameters: WorkflowListToolSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			const result = await manager.execute({ action: "workflow_list" });
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "workflow_replay",
		label: "Workflow Replay",
		description: "Replay a saved workflow in the default browser session, or auto-start a session from workflow metadata.",
		promptSnippet: "Replay a saved workflow by ID or name.",
		promptGuidelines: [
			"Always try workflow_replay first.",
			"If workflow_replay fails, debug likely causes first (session, tab, selectors, navigation timing) before using raw-action fallback.",
			"Use workflow_details only as a last resort fallback to execute raw browser actions manually.",
		],
		parameters: WorkflowReplayToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			const input = params as {
				workflowId?: string;
				workflowName?: string;
				sessionId?: string;
				tabId?: string;
				browserKey?: string;
				profile?: string;
				headless?: boolean;
				timeoutMs?: number;
			};
			try {
				const result = await manager.execute({
					action: "workflow_replay",
					workflowId: input.workflowId,
					workflowName: input.workflowName,
					sessionId: input.sessionId,
					tabId: input.tabId,
					browserKey: input.browserKey,
					profile: input.profile,
					headless: input.headless,
					timeoutMs: input.timeoutMs,
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: result.details,
				};
			} catch (error) {
				const message = (error as Error).message;
				throw new Error(`${message}\n\nworkflow_replay failed. First attempt normal debugging (session/tab selection, page state, timing, selector drift). Use workflow_details only as a last-resort raw-action fallback.`);
			}
		},
	});

	pi.registerTool({
		name: "workflow_details",
		label: "Workflow Details",
		description: "Get full workflow internals including recorded steps and derived raw browser actions for fallback execution.",
		promptSnippet: "Retrieve workflow step details and raw browser-action fallback calls.",
		promptGuidelines: [
			"Use workflow_details after workflow_replay fails and standard debugging has been attempted.",
			"Use details.calls as a last-resort sequence of raw browser actions.",
		],
		parameters: WorkflowDetailsToolSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			manager ??= new BrowserManager(ctx.cwd, loadConfig(ctx.cwd));
			const input = params as { workflowId?: string; workflowName?: string };
			const result = await manager.execute({
				action: "workflow_details",
				workflowId: input.workflowId,
				workflowName: input.workflowName,
			});
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});
}
