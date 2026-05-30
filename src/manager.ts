import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { getAdapter } from "./adapters/index.ts";
import type {
	BrowserSessionRecord,
	BrowserToolInput,
	PageRecord,
	ResolvedConfig,
	SessionSummary,
} from "./types.ts";

interface ToolResponse {
	text: string;
	details: Record<string, unknown>;
}

function truncate(value: string, max = 4000): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated]`;
}

function sanitizeSegment(value: string | undefined, fallback: string): string {
	const base = (value ?? fallback).trim() || fallback;
	return base.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export class BrowserManager {
	private sessions = new Map<string, BrowserSessionRecord>();
	private currentSessionId?: string;
	private nextSessionNumber = 1;

	constructor(
		private readonly cwd: string,
		private config: ResolvedConfig,
	) {}

	setConfig(config: ResolvedConfig): void {
		this.config = config;
	}

	async closeAll(): Promise<void> {
		for (const session of [...this.sessions.values()]) {
			await this.stopSession(session);
		}
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

	private displayPath(path: string): string {
		const rel = relative(this.cwd, path);
		return rel && !rel.startsWith("..") ? rel : path;
	}
}
