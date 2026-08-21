import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureStorageDir, loadConfig } from "./config.ts";
import { BrowserManager } from "./manager.ts";
import { sweepTemporaryProfiles } from "./profile-store.ts";
import type { BrowserToolInput, RawExtensionConfig, ResolvedConfig, SessionSummary, WorkflowStep } from "./types.ts";

async function writeProjectDefaultBrowser(cwd: string, config: ResolvedConfig, browserKey: string): Promise<void> {
	const projectConfigPath = config.configPaths.project;
	const existing: RawExtensionConfig = existsSync(projectConfigPath)
		? (JSON.parse(readFileSync(projectConfigPath, "utf8")) as RawExtensionConfig)
		: {};

	existing.defaultBrowser = browserKey;
	ensureStorageDir(cwd, dirname(projectConfigPath));
	await writeFile(projectConfigPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

/**
 * Surface the one-time profile relocation. `loadConfig` runs on nearly every command but only reports
 * on the run that actually moved something, so this is safe to call once per session start.
 */
function reportProfileMigration(ctx: ExtensionContext, config: ResolvedConfig): void {
	const migration = config.profileMigration;
	if (!migration) return;

	if (migration.moved.length) {
		ctx.ui.notify(
			`pi-puppeteer moved ${migration.moved.length} browser profile(s) out of this project into ${config.profileRoot}. ` +
				"Profiles hold cookies and session tokens, so they are no longer written into your repository.",
			"info",
		);
	}

	const conflicts = migration.pending.filter((entry) => entry.reason === "target-exists");
	if (conflicts.length) {
		ctx.ui.notify(
			`Left ${conflicts.length} profile(s) in place: a profile of the same name already exists in the shared root. ` +
				`They were not merged. Start a session with a different \`profile\` name to keep them, or delete ${conflicts[0]?.source} once you no longer need it.`,
			"error",
		);
	}

	const locked = migration.pending.filter((entry) => entry.reason === "locked");
	if (locked.length) {
		ctx.ui.notify(
			`Deferred ${locked.length} profile(s) still held by a running browser, starting with ${locked[0]?.source}. ` +
				"Close that browser and restart Pi to finish the move.",
			"info",
		);
	}

	const failed = migration.pending.filter((entry) => entry.reason === "failed");
	if (failed.length) {
		ctx.ui.notify(`Could not move ${failed.length} profile(s); they were left untouched at ${failed[0]?.source}.`, "error");
	}
}

function browserOptionLabel(key: string, definition: ResolvedConfig["browsers"][string], currentSetting: string): string {
	const current = key === currentSetting ? " (current)" : "";
	return `${definition.displayName} [${key}] — ${definition.engine}${current}`;
}

function systemOptionLabel(config: ResolvedConfig): string {
	const current = config.defaultBrowserSetting === "system" ? " (current)" : "";
	return `System [${config.systemDefaultBrowser}] — OS default${current}`;
}

function defaultBrowserOptions(config: ResolvedConfig): Array<{ key: string; label: string }> {
	const detected = Object.entries(config.browsers).filter(([, definition]) => Boolean(definition.executablePath));
	return [
		{ key: "system", label: systemOptionLabel(config) },
		...detected.map(([key, definition]) => ({
			key,
			label: browserOptionLabel(key, definition, config.defaultBrowserSetting),
		})),
	];
}

/** How many browsers the default-browser picker shows before it starts scrolling. */
const DEFAULT_BROWSERS_VISIBLE = 6;

export interface DefaultBrowserState {
	options: Array<{ key: string; label: string }>;
	selectedIndex: number;
}

/**
 * The default-browser picker's lines, in the Browser Manager's frame.
 *
 * This used to be `ctx.ui.select`, which drops the user out of the surface the rest of the flow is
 * drawn on. Same frame, same primitives, same height rule as every other list here.
 */
export function defaultBrowserLines(theme: ScreenTheme, width: number, state: DefaultBrowserState): string[] {
	const { options, selectedIndex } = state;
	const frame = screenFrame(theme, width);
	const { innerWidth, bold, border, boxed, clamp } = frame;
	const lines = [
		border("╭", "─", "╮"),
		boxed(theme.fg("text", bold("Default Browser"))),
		boxed(theme.fg("muted", "Used by every browser this project opens without naming one.")),
		boxed(""),
	];

	lines.push(...listRows(frame, {
		items: options,
		selectedIndex,
		maxVisible: DEFAULT_BROWSERS_VISIBLE,
		row: (option, isSelected) => {
			const marker = isSelected ? theme.fg("accent", "›") : " ";
			return tableRow([[`${marker} ${theme.fg(isSelected ? "accent" : "text", option.label)}`, innerWidth]]);
		},
	}));

	lines.push(
		boxed(""),
		...controlBlock(theme, frame, [[
			`${workflowKeycap(theme, "↑↓")} move`,
			`${workflowKeycap(theme, "Enter", "accent")} select`,
			`${workflowKeycap(theme, "Esc")} back`,
		]], 0),
		border("╰", "─", "╯"),
	);
	return clamp(lines);
}

async function chooseDefaultBrowser(
	ctx: ExtensionCommandContext | ExtensionContext,
	config: ResolvedConfig,
): Promise<string | undefined> {
	const options = defaultBrowserOptions(config);
	if (!options.length) return undefined;
	// Start on whichever option is already in force, so Enter is a no-op rather than a surprise.
	let selectedIndex = Math.max(0, options.findIndex((option) => option.key === config.defaultBrowserSetting));
	let requestRender: (() => void) | undefined;
	let component: RecordingScreenComponent | undefined;

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		requestRender = () => tui.requestRender();
		component = {
			render(width: number): string[] {
				return defaultBrowserLines(theme, width, { options, selectedIndex });
			},
			invalidate(): void {},
			handleInput(data: string): void {
				const selectKey = matchSelectKey(data, keybindings);
				if (selectKey === "up") {
					selectedIndex = Math.max(0, selectedIndex - 1);
					requestRender?.();
					return;
				}
				if (selectKey === "down") {
					selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
					requestRender?.();
					return;
				}
				if (selectKey === "cancel") {
					done(undefined);
					return;
				}
				if (selectKey === "confirm") done(options[selectedIndex]?.key);
			},
		};
		return component;
	}).finally(() => {
		component = undefined;
		requestRender = undefined;
	});
}

interface ProfileListEntry {
	browserKey: string;
	displayName: string;
	profile: string;
	inUse: boolean;
	state: "free" | "starting" | "live";
	sessionId: string | null;
	ownerCwd: string | null;
	lastUsedAt: number | null;
}

type ProfilePickerAction =
	| { type: "cancel" }
	| { type: "open"; profile: ProfileListEntry }
	| { type: "new" }
	| { type: "rename"; profile: ProfileListEntry };

/**
 * Work a screen runs once it is mounted, rather than something awaited before it appears.
 *
 * Resolving `ctx.ui.custom` hands the terminal back to the editor, so an await sitting between two
 * screens is painted as the frame vanishing and coming back. Handing the follow-up work to the next
 * screen instead means the swap has nothing to wait for.
 */
interface PendingScreenWork {
	message: string;
	run: () => Promise<void>;
}

/** Status text for a profile row, in the same voice the sessions table uses. */
function profileStatusLabel(entry: ProfileListEntry, cwd: string): string {
	if (entry.sessionId) return `in use by ${entry.sessionId}`;
	if (entry.state === "starting") return "starting…";
	if (!entry.inUse) return "free";
	if (!entry.ownerCwd) return "running outside Pi";
	return entry.ownerCwd === cwd ? "running in this project" : `running — Pi in ${basename(entry.ownerCwd)}`;
}

function profileStatusColor(entry: ProfileListEntry): "success" | "warning" | "muted" {
	if (entry.state === "starting") return "warning";
	return entry.inUse ? "success" : "muted";
}

/** How many profile rows the picker shows before it starts scrolling. */
const PROFILES_VISIBLE = 6;

export interface ProfilePickerState {
	browserLabel: string;
	profiles: ProfileListEntry[];
	selectedIndex: number;
	deleteArmed: boolean;
	/** What is running right now. Shown in the reserved notice row, with the controls dimmed. */
	busy?: string;
	/** Resolves "running in this project" against the project the picker was opened from. */
	cwd: string;
}

/**
 * The profile picker's lines, at a height that depends only on the profile count and the width.
 *
 * Built from the same primitives as `browserManagerLines`, and held to the same invariant, because
 * the two are meant to read as one surface — see `screenFrame`.
 */
export function profilePickerLines(theme: ScreenTheme, width: number, state: ProfilePickerState): string[] {
	const { browserLabel, profiles, selectedIndex, deleteArmed, busy, cwd } = state;
	const frame = screenFrame(theme, width);
	const { innerWidth, bold, dim, border, boxed, clamp } = frame;
	const selected = profiles[selectedIndex];
	const lines = [
		border("╭", "─", "╮"),
		boxed(theme.fg("text", bold(`Browser Profiles — ${browserLabel}`))),
	];

	if (!profiles.length) {
		lines.push(
			boxed(theme.fg("muted", busy ? "" : "No profiles exist yet.")),
			boxed(""),
		);
	} else {
		lines.push(boxed(""));
		const gap = "  ";
		const nameWidth = Math.min(24, Math.max("Profile".length, ...profiles.map((entry) => entry.profile.length + 2)));
		const statusWidth = Math.max(1, innerWidth - nameWidth - gap.length);

		lines.push(boxed(tableRow([[dim("Profile"), nameWidth], [dim("Status"), statusWidth]], gap)));
		lines.push(...listRows(frame, {
			items: profiles,
			selectedIndex,
			maxVisible: PROFILES_VISIBLE,
			row: (entry, isSelected) => {
				const marker = isSelected ? theme.fg("accent", "›") : " ";
				const dot = theme.fg(profileStatusColor(entry), entry.inUse ? "●" : "○");
				const name = theme.fg(isSelected ? "accent" : "text", entry.profile);
				const status = theme.fg(profileStatusColor(entry), profileStatusLabel(entry, cwd));
				return tableRow([[`${marker} ${name}`, nameWidth], [`${dot} ${status}`, statusWidth]], gap);
			},
		}));
	}

	const hint = (key: string, label: string, options: { color?: "accent" | "warning" | "dim"; enabled?: boolean } = {}) => {
		const enabled = (options.enabled ?? true) && !busy;
		return `${workflowKeycap(theme, key, enabled ? options.color ?? "accent" : "dim")} ${enabled ? label : dim(label)}`;
	};
	// `open` and `connect` are different lengths, so both variants are handed to `controlBlock`:
	// otherwise moving the cursor onto a running profile could rewrap the row and move the border.
	const listHints = (openLabel: string) => [
		hint("↑↓", "move", { color: "dim" }),
		hint("Enter", openLabel),
		hint("N", "new"),
		hint("R", "rename"),
		hint("D", "delete", { enabled: selected?.inUse !== true }),
		hint("Esc", "back", { color: "dim" }),
	];
	const hintSets = profiles.length
		? [
			listHints("open"),
			listHints("connect"),
			[hint("D", "confirm delete", { color: "warning" }), hint("Esc", "cancel", { color: "dim" })],
		]
		: [[hint("N", "new profile"), hint("Esc", "back", { color: "dim" })]];
	const activeHints = !profiles.length ? 0 : deleteArmed ? 2 : selected?.inUse ? 1 : 0;

	// A running profile cannot be deleted: removing a live user data dir breaks the browser
	// holding it, which may belong to a Pi session in another project. Renaming is safe —
	// the name lives in a sidecar, so nothing on disk moves.
	const notice = busy
		? theme.fg("warning", busy)
		: deleteArmed && selected
			? theme.fg("warning", `Delete '${selected.profile}'? Signed-in sessions in it are lost.`)
			: selected?.inUse
				? dim("Running profiles cannot be deleted. Enter connects to the browser.")
				: "";
	lines.push(
		boxed(""),
		boxed(notice),
		...controlBlock(theme, frame, hintSets, activeHints),
		border("╰", "─", "╯"),
	);
	return clamp(lines);
}

/**
 * Profile picker, rendered in the same frame as the Browser Manager.
 *
 * Deleting happens in place behind a confirm, the way closing a session does. Renaming needs a text
 * field, which is its own screen, so it exits and the caller re-enters.
 */
async function showProfilePickerScreen(
	ctx: ExtensionCommandContext | ExtensionContext,
	browserLabel: string,
	initialProfiles: ProfileListEntry[],
	loadProfiles: () => Promise<ProfileListEntry[]>,
	deleteProfile: (profile: ProfileListEntry) => Promise<void>,
	pending?: PendingScreenWork,
): Promise<ProfilePickerAction> {
	let profiles = initialProfiles;
	let selectedIndex = 0;
	let deleteArmed = false;
	let busy: string | undefined;
	let generation = 0;
	let requestRender: (() => void) | undefined;
	let component: RecordingScreenComponent | undefined;

	return ctx.ui.custom<ProfilePickerAction>((tui, theme, keybindings, done) => {
		requestRender = () => tui.requestRender();
		// Latest load wins. The refresh on mount can still be probing when a delete starts its own,
		// and the older result must neither overwrite the newer list nor clear the newer notice.
		const reload = async (message?: string) => {
			const mine = ++generation;
			if (message) busy = message;
			requestRender?.();
			try {
				const loaded = await loadProfiles();
				if (mine !== generation) return;
				profiles = loaded;
				selectedIndex = profiles.length ? Math.min(selectedIndex, profiles.length - 1) : 0;
			} catch {
				// Discovery is a convenience; an empty list still lets the caller name a profile outright.
			} finally {
				if (mine === generation) {
					busy = undefined;
					requestRender?.();
				}
			}
		};
		// Probing each profile can take a while, so it runs against the mounted screen. Only say so
		// when there is nothing to show yet; a refresh over an existing list should be silent.
		if (pending) {
			void (async () => {
				busy = pending.message;
				requestRender?.();
				try {
					await pending.run();
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
				}
				await reload();
			})();
		} else {
			void reload(profiles.length ? undefined : "Looking for profiles…");
		}

		const deleteSelectedProfile = async (profile: ProfileListEntry) => {
			busy = "Deleting profile…";
			deleteArmed = false;
			requestRender?.();
			try {
				await deleteProfile(profile);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
			await reload();
		};
		component = {
			render(width: number): string[] {
				return profilePickerLines(theme, width, { browserLabel, profiles, selectedIndex, deleteArmed, busy, cwd: ctx.cwd });
			},
			invalidate(): void {},
			handleInput(data: string): void {
				const selected = profiles[selectedIndex];
				const selectKey = matchSelectKey(data, keybindings);
				if (busy) return;
				if (matchesShortcut(data, "n")) {
					done({ type: "new" });
					return;
				}
				if (selectKey === "up") {
					if (!profiles.length) return;
					selectedIndex = Math.max(0, selectedIndex - 1);
					deleteArmed = false;
					requestRender?.();
					return;
				}
				if (selectKey === "down") {
					if (!profiles.length) return;
					selectedIndex = Math.min(profiles.length - 1, selectedIndex + 1);
					deleteArmed = false;
					requestRender?.();
					return;
				}
				if (selectKey === "cancel") {
					if (deleteArmed) {
						deleteArmed = false;
						requestRender?.();
						return;
					}
					done({ type: "cancel" });
					return;
				}
				if (!selected) return;
				if (selectKey === "confirm") {
					done({ type: "open", profile: selected });
					return;
				}
				if (matchesShortcut(data, "r")) {
					done({ type: "rename", profile: selected });
					return;
				}
				if (matchesShortcut(data, "d")) {
					if (selected.inUse) {
						ctx.ui.notify(`Cannot delete '${selected.profile}': a browser is running on it.`, "error");
						return;
					}
					if (deleteArmed) {
						void deleteSelectedProfile(selected);
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

/**
 * Ask which profile to open, showing which ones already have a browser running.
 *
 * Profiles are shared across projects, so launching blind means finding out about a collision only
 * after the fact. Picking a running profile is allowed and connects to that browser.
 *
 * Returns the chosen profile name, or undefined when the user backs out.
 */
async function chooseProfile(
	ctx: ExtensionCommandContext | ExtensionContext,
	manager: BrowserManager,
	browserKey: string,
	browserLabel: string,
): Promise<string | undefined> {
	// Kept across iterations so re-entering the picker draws the list it had rather than an empty
	// frame, while the refresh it runs on mount catches anything that changed meanwhile.
	let entries: ProfileListEntry[] = [];
	const listProfiles = async (): Promise<ProfileListEntry[]> => {
		try {
			const listed = await manager.execute({ action: "list_profiles", browserKey });
			entries = (listed.details.profiles as ProfileListEntry[] | undefined) ?? [];
		} catch {
			// Discovery is a convenience; naming a profile outright still works without it.
		}
		return entries;
	};

	let pending: PendingScreenWork | undefined;
	while (true) {
		const action = await showProfilePickerScreen(
			ctx,
			browserLabel,
			entries,
			listProfiles,
			async (profile) => {
				const deleted = await manager.execute({ action: "delete_profile", browserKey, profile: profile.profile });
				ctx.ui.notify(deleted.text, "info");
			},
			pending,
		);
		pending = undefined;

		if (action.type === "cancel") return undefined;
		if (action.type === "open") return action.profile.profile;

		// Both branches fall straight into the name screen with nothing awaited in between, so the
		// renderer coalesces the swap and the editor is never painted between the two frames.
		const takenNames = entries.map((entry) => entry.profile);
		if (action.type === "new") {
			const name = await showNameEntryScreen(ctx, {
				title: `New Profile — ${browserLabel}`,
				confirmLabel: "create",
				subject: "profile",
				context: `${browserLabel} profile.`,
				initial: suggestProfileName(takenNames),
				taken: takenNames,
			});
			if (name) return name;
			continue;
		}

		const renamed = await showNameEntryScreen(ctx, {
			title: `Rename Profile — ${browserLabel}`,
			confirmLabel: "rename",
			subject: "profile",
			context: `${browserLabel} profile.`,
			initial: action.profile.profile,
			taken: takenNames,
		});
		if (!renamed || renamed === action.profile.profile) continue;
		pending = {
			message: "Renaming profile…",
			run: async () => {
				const result = await manager.execute({
					action: "rename_profile",
					browserKey,
					profile: action.profile.profile,
					targetProfile: renamed,
				});
				ctx.ui.notify(result.text, "info");
			},
		};
	}
}

/** Suggest a name no existing profile is using, so "New profile…" lands somewhere free. */
function suggestProfileName(names: string[]): string {
	const taken = new Set(names.map((name) => name.trim().toLowerCase()));
	if (!taken.has("default")) return "default";
	let suffix = 2;
	while (taken.has(`default-${suffix}`)) suffix += 1;
	return `default-${suffix}`;
}

export interface ProfileNameState {
	/** The name as it will be stored; empty when nothing usable was typed. */
	name: string;
	collides: boolean;
	canConfirm: boolean;
}

/**
 * Judge a typed profile name once, for both the status line and the Enter key.
 *
 * Names are stored verbatim — the directory is named by a separate sanitized ID, so a profile can be
 * called "My Work!" without that leaking into a path. Only emptiness and collisions can refuse a name,
 * and deciding both in one place keeps the status line and the key handler from drifting apart.
 */
export function profileNameState(value: string, initial: string, taken: Iterable<string>): ProfileNameState {
	const name = value.trim();
	const takenNames = new Set([...taken].map((entry) => entry.trim().toLowerCase()));
	const collides = name.toLowerCase() !== initial.trim().toLowerCase() && takenNames.has(name.toLowerCase());
	return { name, collides, canConfirm: Boolean(name) && !collides };
}

/** Printable text, including a paste. Escape sequences and control keys are handled separately. */
export function printableInput(data: string): string | undefined {
	if (!data.length) return undefined;
	for (const character of data) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return undefined;
	}
	return data;
}

export interface NameEntryOptions {
	/** The whole heading, e.g. `New Profile — Microsoft Edge`. */
	title: string;
	confirmLabel: string;
	/** The noun in "Enter a profile name." and "A profile named 'x' already exists." */
	subject: string;
	/** What the name will belong to, shown once it is usable, e.g. `Microsoft Edge profile.` */
	context: string;
	initial: string;
	taken: string[];
	/**
	 * Names only a manager call knows about.
	 *
	 * Loaded against the mounted field rather than before it: awaiting between two screens hands the
	 * terminal back to the editor, which reads as the frame vanishing and returning.
	 */
	loadTaken?: () => Promise<string[]>;
	/** A starting name to fill in once `loadTaken` lands, if nothing has been typed by then. */
	suggest?: (taken: string[]) => string;
}

/**
 * Text entry for a name, rendered in the Browser Manager's frame.
 *
 * Names are kept exactly as typed, so the field only has to refuse an empty name or one already taken,
 * rather than letting the manager reject it afterwards. Shared by profiles and browsers so that
 * naming anything looks the same; before this, renaming a browser dropped out to a plain prompt.
 */
async function showNameEntryScreen(
	ctx: ExtensionCommandContext | ExtensionContext,
	options: NameEntryOptions,
): Promise<string | undefined> {
	let value = options.initial;
	let cursor = value.length;
	let taken = options.taken;
	let touched = false;
	let requestRender: (() => void) | undefined;
	let component: RecordingScreenComponent | undefined;

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		requestRender = () => tui.requestRender();
		if (options.loadTaken) {
			void options.loadTaken()
				.then((loaded) => {
					taken = loaded;
					// Only move the field the user has not touched yet; typing always wins.
					if (!touched && options.suggest) {
						value = options.suggest(loaded);
						cursor = value.length;
					}
				})
				.catch(() => {
					// Discovery is a convenience. Without it the manager refuses a duplicate afterwards.
				})
				.finally(() => requestRender?.());
		}
		component = {
			render(width: number): string[] {
				const frame = screenFrame(theme, width);
				const { innerWidth, bold, border, boxed, clamp } = frame;

				const label = "Name  ";
				const fieldWidth = Math.max(8, innerWidth - label.length);
				// Keep the cursor on screen for names longer than the field.
				const start = Math.max(0, Math.min(cursor - fieldWidth + 1, Math.max(0, value.length - fieldWidth + 1)));
				const visible = value.slice(start, start + fieldWidth);
				const localCursor = cursor - start;
				const before = visible.slice(0, localCursor);
				const atCursor = visible.slice(localCursor, localCursor + 1) || " ";
				const after = visible.slice(localCursor + 1);
				const cursorCell = "bg" in theme && typeof theme.bg === "function" ? theme.bg("selectedBg", atCursor) : theme.fg("accent", atCursor);
				const field = `${theme.fg("dim", label)}${theme.fg("text", before)}${cursorCell}${theme.fg("text", after)}`;

				const { name, collides, canConfirm } = profileNameState(value, options.initial, taken);
				const status = !name
					? theme.fg("dim", `Enter a ${options.subject} name.`)
					: collides
						? theme.fg("error", `A ${options.subject} named '${name}' already exists.`)
						: theme.fg("dim", options.context);

				const controls: string[] = [
					canConfirm
						? `${workflowKeycap(theme, "Enter", "accent")} ${options.confirmLabel}`
						: theme.fg("dim", `[Enter] ${options.confirmLabel}`),
					`${workflowKeycap(theme, "Esc")} cancel`,
				];

				return clamp([
					border("╭", "─", "╮"),
					boxed(theme.fg("text", bold(options.title))),
					boxed(""),
					boxed(field),
					boxed(""),
					boxed(status),
					...controlBlock(theme, frame, [controls], 0),
					border("╰", "─", "╯"),
				]);
			},
			invalidate(): void {},
			handleInput(data: string): void {
				// Typing wins over every binding: a select keybinding on a letter must not eat input.
				const typed = printableInput(data);
				if (typed) {
					touched = true;
					value = value.slice(0, cursor) + typed + value.slice(cursor);
					cursor += typed.length;
					requestRender?.();
					return;
				}

				if (data === "\x7f" || data === "\b") {
					if (cursor > 0) {
						touched = true;
						value = value.slice(0, cursor - 1) + value.slice(cursor);
						cursor -= 1;
						requestRender?.();
					}
					return;
				}
				if (data === "\x1b[3~") {
					if (cursor < value.length) {
						touched = true;
						value = value.slice(0, cursor) + value.slice(cursor + 1);
						requestRender?.();
					}
					return;
				}
				if (data === "\x15") {
					touched = true;
					value = value.slice(cursor);
					cursor = 0;
					requestRender?.();
					return;
				}
				if (data === "\x1b[D") {
					cursor = Math.max(0, cursor - 1);
					requestRender?.();
					return;
				}
				if (data === "\x1b[C") {
					cursor = Math.min(value.length, cursor + 1);
					requestRender?.();
					return;
				}
				if (data === "\x1b[H" || data === "\x1b[1~") {
					cursor = 0;
					requestRender?.();
					return;
				}
				if (data === "\x1b[F" || data === "\x1b[4~") {
					cursor = value.length;
					requestRender?.();
					return;
				}

				const selectKey = matchSelectKey(data, keybindings);
				if (selectKey === "cancel") {
					done(undefined);
					return;
				}
				if (selectKey === "confirm") {
					const { name, canConfirm } = profileNameState(value, options.initial, taken);
					if (canConfirm) done(name);
				}
			},
		};
		return component;
	}).finally(() => {
		component = undefined;
		requestRender = undefined;
	});
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

/**
 * What the Browser Manager cannot finish on its own.
 *
 * Opening, showing, closing, renaming and saving all run against the mounted screen instead — see
 * `InFrameAction`. What is left is the cases that genuinely need a different screen first.
 */
type SessionManagerAction =
	| { type: "exit" }
	| { type: "create-with-profile" }
	| { type: "save"; session: SessionSummary }
	| { type: "change-default-browser" }
	| { type: "rename"; session: SessionSummary };

const WORKFLOW_RECORDING_WIDGET_KEY = "pi-puppeteer-workflow-recording";
const WORKFLOW_RECORDING_STATUS_KEY = "pi-puppeteer-workflow";
const BROWSER_SESSIONS_STATUS_KEY = "pi-puppeteer-sessions";
const BROWSER_SESSIONS_WIDGET_KEY = "pi-puppeteer-sessions-widget";
const BROWSER_MANAGER_SHORTCUT_HINT = " [Alt+B]";

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

/** The numeric parameters of an SGR sequence, reading an omitted parameter as 0 the way terminals do. */
function sgrParameters(sequence: string): number[] {
	const body = sequence.slice(2, -1);
	if (!body) return [0];
	return body.split(";").map((parameter) => (parameter ? Number.parseInt(parameter, 10) : 0));
}

/**
 * Truncate to a visible width, keeping the styling that survives the cut and closing what it opened.
 *
 * Cutting mid-run drops that run's reset, and the colour then bleeds through the padding `padAnsiEnd`
 * adds and on into the next column. Only the attributes actually left open are closed: a blanket
 * `\x1b[0m` would also cancel the row highlight `selectedLine` paints around the finished line.
 */
export function truncateAnsi(value: string, width: number): string {
	if (width <= 0) return "";
	if (stripAnsi(value).length <= width) return value;
	let visible = 0;
	let output = "";
	let foreground = false;
	let background = false;
	let bold = false;
	for (let index = 0; index < value.length;) {
		if (value[index] === "\x1b") {
			const match = value.slice(index).match(/^\x1B\[[0-?]*[ -/]*[@-~]/);
			if (match) {
				output += match[0];
				if (match[0].endsWith("m")) {
					const parameters = sgrParameters(match[0]);
					for (let position = 0; position < parameters.length; position += 1) {
						const parameter = parameters[position]!;
						if (parameter === 38 || parameter === 48) {
							if (parameter === 38) foreground = true;
							else background = true;
							// `5;n` picks a 256-colour index and `2;r;g;b` a truecolor triple. Step over the
							// operands so a colour component is never read back as an attribute of its own.
							position += parameters[position + 1] === 2 ? 4 : parameters[position + 1] === 5 ? 2 : 1;
							continue;
						}
						if (parameter === 0) foreground = background = bold = false;
						else if (parameter === 1) bold = true;
						else if (parameter === 22) bold = false;
						else if (parameter === 39) foreground = false;
						else if (parameter === 49) background = false;
						else if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) foreground = true;
						else if ((parameter >= 40 && parameter <= 47) || (parameter >= 100 && parameter <= 107)) background = true;
					}
				}
				index += match[0].length;
				continue;
			}
		}
		if (visible >= width - 1) break;
		output += value[index];
		visible += 1;
		index += 1;
	}
	const reset = `${bold ? "\x1b[22m" : ""}${foreground ? "\x1b[39m" : ""}${background ? "\x1b[49m" : ""}`;
	return `${output}…${reset}`;
}

function padAnsiEnd(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - stripAnsi(value).length))}`;
}

function joinColumns(left: string, right: string, width: number): string {
	const rightWidth = stripAnsi(right).length;
	if (rightWidth >= width) {
		return truncateAnsi(right, width);
	}
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

interface ScreenTheme {
	fg: (color: any, text: string) => string;
	bold?: (text: string) => string;
	bg?: (color: any, text: string) => string;
}

export interface ScreenFrame {
	innerWidth: number;
	bold(text: string): string;
	dim(text: string): string;
	border(left: string, fill: string, right: string): string;
	boxed(content?: string): string;
	selectedLine(content: string): string;
	/** Trim finished lines to the real terminal width. */
	clamp(lines: string[]): string[];
}

/**
 * The bordered box every Pi-puppeteer screen is drawn in.
 *
 * Shared so the screens stay visually identical: they are meant to read as one surface, and five
 * copies of this arithmetic drifted apart the moment any of them was adjusted.
 */
export function screenFrame(theme: ScreenTheme, width: number): ScreenFrame {
	const minWidth = Math.max(24, width);
	const innerWidth = Math.max(1, minWidth - 4);
	const fit = (content: string) => padAnsiEnd(truncateAnsi(content, innerWidth), innerWidth);

	return {
		innerWidth,
		bold: (text) => (typeof theme.bold === "function" ? theme.bold(text) : text),
		dim: (text) => theme.fg("dim", text),
		border: (left, fill, right) => theme.fg("borderMuted", `${left}${fill.repeat(Math.max(0, minWidth - 2))}${right}`),
		boxed: (content = "") => `${theme.fg("borderMuted", "│ ")}${fit(content)}${theme.fg("borderMuted", " │")}`,
		selectedLine: (content) => {
			const padded = fit(content);
			const highlighted = typeof theme.bg === "function" ? theme.bg("selectedBg", padded) : padded;
			return `${theme.fg("borderMuted", "│ ")}${highlighted}${theme.fg("borderMuted", " │")}`;
		},
		clamp: (lines) => lines.map((line) => truncateAnsi(line, width)),
	};
}

/** Gap between two control hints, and the indent a wrapped line is not given. */
const CONTROL_GAP = "  ";

/**
 * Lay control hints out across as few lines as they fit on.
 *
 * One line is the common case and stays exactly as it was. The row only wraps when it would otherwise
 * be truncated, and truncation here is worse than it looks: the hints are ordered by how routine they
 * are, so the first thing an 80-column terminal loses is `Esc back` — the one binding a user reaches
 * for when they are stuck. Shared for the same reason `screenFrame` is: every screen's controls should
 * behave identically. The workflow library keeps its own separator and is left alone.
 */
export function controlLines(theme: ScreenTheme, hints: string[], innerWidth: number): string[] {
	const separator = theme.fg("dim", CONTROL_GAP);
	const lines: string[] = [];
	let current: string[] = [];
	let currentWidth = 0;

	for (const hint of hints) {
		const hintWidth = stripAnsi(hint).length;
		const projected = current.length ? currentWidth + CONTROL_GAP.length + hintWidth : hintWidth;
		if (current.length && projected > innerWidth) {
			lines.push(current.join(separator));
			current = [hint];
			currentWidth = hintWidth;
			continue;
		}
		current.push(hint);
		currentWidth = projected;
	}
	if (current.length) lines.push(current.join(separator));
	// A hint wider than the frame still has to produce a line; the frame truncates it.
	return lines.length ? lines : [""];
}

/**
 * The control hints, at a height that does not depend on which set is showing.
 *
 * Arming a confirm swaps the hints for a shorter, differently worded set, and at some widths that
 * changes how many lines `controlLines` wraps to — which moves the bottom border while the user is
 * mid-decision. Padding every set out to the widest one holds the frame still. Matching the label
 * lengths by hand would not: `close` and `confirm close` are legitimately different words.
 */
export function controlBlock(theme: ScreenTheme, frame: ScreenFrame, hintSets: string[][], active: number): string[] {
	const height = Math.max(...hintSets.map((hints) => controlLines(theme, hints, frame.innerWidth).length));
	const lines = controlLines(theme, hintSets[active] ?? [], frame.innerWidth).map((line) => frame.boxed(line));
	while (lines.length < height) lines.push(frame.boxed(""));
	return lines;
}

/** Lay cells out in fixed-width columns, each padded and truncated to fit its own column. */
export function tableRow(cells: Array<[content: string, width: number]>, gap = "  "): string {
	return cells.map(([content, width]) => padAnsiEnd(truncateAnsi(content, width), width)).join(gap);
}

export interface ListRowsSpec<T> {
	items: T[];
	selectedIndex: number;
	maxVisible: number;
	/** A row's content, before the frame adds its border and selection highlight. */
	row(item: T, isSelected: boolean, index: number): string;
}

/**
 * The scrolling row block both list screens draw, at a height that depends only on the list length.
 *
 * Both overflow markers are always drawn, blank when there is nothing above or below. They used to be
 * pushed only when they had something to say, so arrowing through a list changed the screen's height —
 * and because these screens are inline rather than overlays, a height change repaints everything from
 * that line to the bottom of the terminal. The whole box appeared to twitch on every keypress.
 */
export function listRows<T>(frame: ScreenFrame, spec: ListRowsSpec<T>): string[] {
	const { items, selectedIndex, maxVisible, row } = spec;
	const visibleCount = Math.min(maxVisible, items.length);
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), items.length - visibleCount));
	const end = start + visibleCount;

	const lines = [frame.boxed(start > 0 ? frame.dim(`… ${start} earlier`) : "")];
	for (let index = start; index < end; index += 1) {
		const isSelected = index === selectedIndex;
		const rendered = row(items[index]!, isSelected, index);
		lines.push(isSelected ? frame.selectedLine(rendered) : frame.boxed(rendered));
	}
	lines.push(frame.boxed(end < items.length ? frame.dim(`… ${items.length - end} more`) : ""));
	return lines;
}

type SelectKeyAction = "up" | "down" | "confirm" | "cancel";

const SELECT_KEYBINDINGS: Record<SelectKeyAction, "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"> = {
	up: "tui.select.up",
	down: "tui.select.down",
	confirm: "tui.select.confirm",
	cancel: "tui.select.cancel",
};

function matchSelectKey(data: string, keybindings: KeybindingsManager): SelectKeyAction | undefined {
	for (const action of ["up", "down", "confirm", "cancel"] as const) {
		if (keybindings.matches(data, SELECT_KEYBINDINGS[action])) return action;
	}
	return undefined;
}

function printableShortcut(data: string): string | undefined {
	if (data.length === 1) return data.toLowerCase();

	// Kitty/CSI-u printable keys are encoded as ESC [ <unicode codepoint> ; <modifiers> u.
	// Keep this intentionally small: it only extends existing one-letter shortcuts.
	const csiUMatch = data.match(/^\x1b\[(\d+)(?:;\d+)?u$/);
	if (!csiUMatch) return undefined;
	const codePoint = Number(csiUMatch[1]);
	if (!Number.isInteger(codePoint) || codePoint < 32 || codePoint > 126) return undefined;
	return String.fromCodePoint(codePoint).toLowerCase();
}

function matchesShortcut(data: string, shortcut: string): boolean {
	return printableShortcut(data) === shortcut.toLowerCase();
}

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
		return await ctx.ui.custom<"stop" | "background">((tui, theme, keybindings, done) => {
			requestRender = () => tui.requestRender();
			component = {
				render(width: number): string[] {
					const recording = activeRecording ?? initialRecording;
					const recentSteps = recording.recentSteps ?? [];
					const hiddenCount = Math.max(0, recording.stepCount - recentSteps.length);
					const { innerWidth, bold, border, boxed, clamp } = screenFrame(theme, width);
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
					return clamp(lines);
				},
				handleInput(data: string): void {
					const selectKey = matchSelectKey(data, keybindings);
					if (selectKey === "confirm") done("stop");
					if (selectKey === "cancel") done("background");
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

	return ctx.ui.custom<WorkflowLibraryAction>((tui, theme, keybindings, done) => {
		requestRender = () => tui.requestRender();
		component = {
			render(width: number): string[] {
				const { innerWidth, bold, border, boxed, clamp } = screenFrame(theme, width);
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
				return clamp(lines);
			},
			invalidate(): void {},
			handleInput(data: string): void {
				const selected = workflows[selectedIndex];
				const selectKey = matchSelectKey(data, keybindings);
				if (selectKey === "up") {
					if (!workflows.length) return;
					selectedIndex = Math.max(0, selectedIndex - 1);
					deleteArmed = false;
					requestRender?.();
					return;
				}
				if (selectKey === "down") {
					if (!workflows.length) return;
					selectedIndex = Math.min(workflows.length - 1, selectedIndex + 1);
					deleteArmed = false;
					requestRender?.();
					return;
				}
				if (matchesShortcut(data, "n")) {
					done({ type: "start" });
					return;
				}
				if (selectKey === "cancel") {
					if (deleteArmed) {
						deleteArmed = false;
						requestRender?.();
						return;
					}
					done({ type: "exit" });
					return;
				}
				if (!selected) return;
				if (selectKey === "confirm") {
					done({ type: "replay", workflow: selected });
					return;
				}
				if (matchesShortcut(data, "r")) {
					done({ type: "rename", workflow: selected });
					return;
				}
				if (matchesShortcut(data, "e")) {
					done({ type: "export", workflow: selected });
					return;
				}
				if (matchesShortcut(data, "d")) {
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

function setBrowserSessionsStatus(ctx: WorkflowStatusUiContext, count: number): void {
	ctx.ui.setStatus(BROWSER_SESSIONS_STATUS_KEY, undefined);
	if (count <= 0) {
		ctx.ui.setWidget?.(BROWSER_SESSIONS_WIDGET_KEY, undefined);
		return;
	}
	if (!ctx.ui.setWidget) {
		const label = ctx.ui.theme.fg("accent", count === 1 ? "Browser Session" : "Browser Sessions");
		const total = ctx.ui.theme.fg("text", `: ${count}`);
		const hint = ctx.ui.theme.fg("dim", BROWSER_MANAGER_SHORTCUT_HINT);
		ctx.ui.setStatus(BROWSER_SESSIONS_STATUS_KEY, `${label}${total}${hint}`);
		return;
	}
	const widgetFactory = ((_tui: any, theme: any) => ({
		render(width: number): string[] {
			const label = theme.fg("accent", count === 1 ? "Browser Session" : "Browser Sessions");
			const total = theme.fg("text", `: ${count}`);
			const hint = theme.fg("dim", BROWSER_MANAGER_SHORTCUT_HINT);
			return [joinColumns("", `${label}${total}${hint}`, width)];
		},
		invalidate(): void {},
	})) as any;
	ctx.ui.setWidget(BROWSER_SESSIONS_WIDGET_KEY, widgetFactory, { placement: "aboveEditor" });
}

/** How a session's profile reads in the manager: kept and named, throwaway, or someone else's browser. */
function sessionProfileLabel(session: SessionSummary): string {
	if (session.mode === "attach") return "attached";
	if (session.temporary) return "temporary";
	return session.profile ?? "—";
}

/** How many session rows the manager shows before it starts scrolling. */
const SESSIONS_VISIBLE = 6;

export interface BrowserManagerState {
	sessions: SessionSummary[];
	selectedIndex: number;
	closeArmed: boolean;
	/** What is running right now. Shown in the reserved notice row, with the controls dimmed. */
	busy?: string;
}

/**
 * The Browser Manager's lines, at a height that depends only on the session count and the width.
 *
 * Pulled out of the component so `scripts/verify.ts` can assert that: the screen is inline rather
 * than an overlay, so every line the height changes by repaints the box, the editor, and the footer
 * beneath it. Selection, an armed confirm, and an operation in flight must all leave it alone.
 */
export function browserManagerLines(theme: ScreenTheme, width: number, state: BrowserManagerState): string[] {
	const { sessions, selectedIndex, closeArmed, busy } = state;
	const frame = screenFrame(theme, width);
	const { innerWidth, bold, dim, border, boxed, clamp } = frame;
	const selected = sessions[selectedIndex];
	const lines = [
		border("╭", "─", "╮"),
		boxed(theme.fg("text", bold("Browser Manager"))),
	];

	if (!sessions.length) {
		lines.push(
			boxed(theme.fg("muted", "No browser sessions are open.")),
			boxed(""),
		);
	} else {
		lines.push(boxed(""));
		const gap = "  ";
		const nameWidth = Math.min(24, Math.max("Name".length, ...sessions.map((session) => session.name.length + 2)));
		const minBrowserWidth = 10;
		const minProfileWidth = 9;
		const naturalBrowserWidth = Math.min(28, Math.max("Browser".length, ...sessions.map((session) => session.displayName.length)));
		const naturalProfileWidth = Math.min(20, Math.max("Profile".length, ...sessions.map((session) => sessionProfileLabel(session).length)));
		const fullTableFixedWidth = nameWidth + gap.length;
		const useFullTable = fullTableFixedWidth + minBrowserWidth <= innerWidth;
		// The profile column is the first thing to go on a narrow terminal: which browser a
		// session is driving matters more than whether its profile is being kept.
		const withProfile = useFullTable && fullTableFixedWidth + minBrowserWidth + gap.length + minProfileWidth <= innerWidth;
		const profileWidth = withProfile
			? Math.min(naturalProfileWidth, innerWidth - fullTableFixedWidth - minBrowserWidth - gap.length)
			: 0;
		const browserWidth = useFullTable
			? Math.min(
				naturalBrowserWidth,
				Math.max(minBrowserWidth, innerWidth - fullTableFixedWidth - (withProfile ? profileWidth + gap.length : 0)),
			)
			: 0;
		const compactDetailsWidth = Math.max(1, innerWidth - nameWidth - gap.length);
		const detailsWidth = useFullTable ? browserWidth : compactDetailsWidth;

		const header: Array<[string, number]> = [[dim("Name"), nameWidth], [dim("Browser"), detailsWidth]];
		if (withProfile) header.push([dim("Profile"), profileWidth]);
		lines.push(boxed(tableRow(header, gap)));

		lines.push(...listRows(frame, {
			items: sessions,
			selectedIndex,
			maxVisible: SESSIONS_VISIBLE,
			row: (session, isSelected) => {
				const marker = isSelected ? theme.fg("accent", "›") : " ";
				const name = theme.fg(isSelected ? "accent" : "text", session.name);
				const browser = theme.fg(isSelected ? "accent" : "text", session.displayName);
				const columns: Array<[string, number]> = [[`${marker} ${name}`, nameWidth], [browser, detailsWidth]];
				if (withProfile) {
					const label = sessionProfileLabel(session);
					columns.push([theme.fg(session.temporary ? "muted" : isSelected ? "accent" : "text", label), profileWidth]);
				}
				return tableRow(columns, gap);
			},
		}));
	}

	// Dimming a hint rather than dropping it keeps the block's wrap — and so the frame's height — the
	// same as the cursor moves and while an action runs. The width is unchanged either way, since
	// `controlLines` measures the visible text.
	const hint = (key: string, label: string, options: { color?: "accent" | "warning" | "dim"; enabled?: boolean } = {}) => {
		const enabled = (options.enabled ?? true) && !busy;
		return `${workflowKeycap(theme, key, enabled ? options.color ?? "accent" : "dim")} ${enabled ? label : dim(label)}`;
	};
	// Every variant is handed to `controlBlock`, not just the live one. `close` and `detach` are
	// different lengths, so which session the cursor is on decides where the row wraps — and the
	// block can only pad to a height it has been shown.
	const listHints = (stopLabel: string) => [
		hint("↑↓", "move", { color: "dim" }),
		hint("Enter", "show"),
		hint("N", "new"),
		hint("L", "load profile"),
		// Always offered, so the row does not change shape as the cursor crosses between a
		// throwaway session and a saved one. Dimmed where it would only explain itself.
		hint("S", "save profile", { enabled: selected?.temporary === true }),
		hint("R", "rename"),
		hint("D", stopLabel),
		hint("B", "change default browser"),
		hint("Esc", "back", { color: "dim" }),
	];
	const armedHints = (confirmLabel: string) => [
		hint("D", confirmLabel, { color: "warning" }),
		hint("Esc", "cancel", { color: "dim" }),
	];
	const attached = selected?.mode === "attach";
	const hintSets = sessions.length
		? [listHints("close"), listHints("detach"), armedHints("confirm close"), armedHints("confirm detach")]
		: [[
			hint("N", "new"),
			hint("L", "load profile"),
			hint("B", "change default browser"),
			hint("Esc", "back", { color: "dim" }),
		]];
	const activeHints = !sessions.length ? 0 : closeArmed ? (attached ? 3 : 2) : (attached ? 1 : 0);

	// Closing is the one irreversible step in the throwaway flow, and it is already behind a
	// two-press confirm, so naming what goes with it costs nothing and prevents a silent loss.
	const notice = busy
		? theme.fg("warning", busy)
		: closeArmed && selected?.temporary
			? theme.fg("warning", "Temporary — closing discards its signed-in sessions. Esc, then S to keep.")
			: "";
	lines.push(
		boxed(""),
		boxed(notice),
		...controlBlock(theme, frame, hintSets, activeHints),
		border("╰", "─", "╯"),
	);
	return clamp(lines);
}

/**
 * Work the manager runs without leaving its frame.
 *
 * Resolving `ctx.ui.custom` hands the terminal back to the editor, so anything awaited between two
 * screens is painted as the box vanishing and returning. Everything here therefore runs against the
 * mounted screen instead, with its notice row saying what is happening.
 */
type InFrameAction =
	| { type: "show"; session: SessionSummary }
	| { type: "close"; session: SessionSummary }
	| { type: "create"; profile?: string }
	| { type: "rename"; session: SessionSummary; name: string }
	| { type: "save"; session: SessionSummary; profile: string };

interface PendingAction {
	action: InFrameAction;
	message: string;
}

async function showBrowserSessionsScreen(
	ctx: ExtensionCommandContext | ExtensionContext,
	initialSessions: SessionSummary[],
	preferredSessionId: string | undefined,
	perform: (action: InFrameAction) => Promise<SessionSummary[]>,
	pending?: PendingAction,
): Promise<SessionManagerAction> {
	let sessions = initialSessions;
	let selectedIndex = Math.max(0, sessions.findIndex((session) => session.id === preferredSessionId || (!preferredSessionId && session.current)));
	let closeArmed = false;
	let busy: string | undefined;
	let requestRender: (() => void) | undefined;
	let component: RecordingScreenComponent | undefined;

	return ctx.ui.custom<SessionManagerAction>((tui, theme, keybindings, done) => {
		requestRender = () => tui.requestRender();
		const runInFrame = async (action: InFrameAction, message: string) => {
			if (busy) return;
			busy = message;
			closeArmed = false;
			requestRender?.();
			try {
				sessions = await perform(action);
				const current = sessions.findIndex((session) => session.current);
				// Opening a browser should land on it; everything else keeps the cursor where it was.
				selectedIndex = action.type === "create" && current >= 0
					? current
					: sessions.length ? Math.min(selectedIndex, sessions.length - 1) : 0;
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			} finally {
				busy = undefined;
				requestRender?.();
			}
		};
		// Started here rather than before the mount so the box is already on screen while it runs.
		if (pending) void runInFrame(pending.action, pending.message);
		component = {
			render(width: number): string[] {
				return browserManagerLines(theme, width, { sessions, selectedIndex, closeArmed, busy });
			},
			invalidate(): void {},
			handleInput(data: string): void {
				const selected = sessions[selectedIndex];
				const selectKey = matchSelectKey(data, keybindings);
				if (busy) return;
				if (matchesShortcut(data, "n")) {
					void runInFrame({ type: "create" }, "Opening browser…");
					return;
				}
				if (matchesShortcut(data, "l")) {
					done({ type: "create-with-profile" });
					return;
				}
				if (matchesShortcut(data, "b")) {
					done({ type: "change-default-browser" });
					return;
				}
				if (selectKey === "up") {
					if (!sessions.length) return;
					selectedIndex = Math.max(0, selectedIndex - 1);
					closeArmed = false;
					requestRender?.();
					return;
				}
				if (selectKey === "down") {
					if (!sessions.length) return;
					selectedIndex = Math.min(sessions.length - 1, selectedIndex + 1);
					closeArmed = false;
					requestRender?.();
					return;
				}
				if (selectKey === "cancel") {
					if (closeArmed) {
						closeArmed = false;
						requestRender?.();
						return;
					}
					done({ type: "exit" });
					return;
				}
				if (!selected) return;
				if (selectKey === "confirm") {
					void runInFrame({ type: "show", session: selected }, "Showing browser…");
					return;
				}
				if (matchesShortcut(data, "s")) {
					if (!selected.temporary) {
						ctx.ui.notify(
							selected.mode === "attach"
								? `${selected.id} is attached to a browser Pi did not launch, so it has no profile to save.`
								: `${selected.id} already uses saved profile '${selected.profile}'.`,
							"error",
						);
						return;
					}
					done({ type: "save", session: selected });
					return;
				}
				if (matchesShortcut(data, "r")) {
					done({ type: "rename", session: selected });
					return;
				}
				if (matchesShortcut(data, "d")) {
					if (closeArmed) {
						void runInFrame({ type: "close", session: selected }, selected.mode === "attach" ? "Detaching browser…" : "Closing browser…");
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
	let config = loadConfig(ctx.cwd);
	browserManager.setConfig(config);

	const listSessions = async (): Promise<SessionSummary[]> => {
		const result = await browserManager.execute({ action: "sessions" });
		return ((result.details.sessions as SessionSummary[] | undefined) ?? []);
	};

	/** A free `Browser-N`, so opening a browser lands on a name nothing else is using. */
	const suggestSessionName = (existing: SessionSummary[]): string => {
		const taken = new Set(existing.map((session) => session.name.toLowerCase()));
		let suffix = 1;
		while (taken.has(`browser-${suffix}`)) suffix += 1;
		return `Browser-${suffix}`;
	};

	let sessions = await listSessions();
	let selectedSessionId: string | undefined;
	let pending: PendingAction | undefined;

	/** Never rejects: the manager screen stays up, so a failure is a notification, not a torn frame. */
	const perform = async (action: InFrameAction): Promise<SessionSummary[]> => {
		try {
			if (action.type === "close") {
				const stopped = await browserManager.execute({ action: "stop", sessionId: action.session.id });
				if (!stopped.details.alreadyClosed) ctx.ui.notify(stopped.text, "info");
			} else if (action.type === "show") {
				const shown = await browserManager.execute({ action: "show_session", sessionId: action.session.id });
				ctx.ui.notify(shown.text, "info");
			} else if (action.type === "create") {
				const started = await browserManager.execute({
					action: "start",
					name: suggestSessionName(sessions),
					profile: action.profile,
				});
				ctx.ui.notify(started.text, "info");
			} else if (action.type === "rename") {
				const renamed = await browserManager.execute({ action: "rename_session", sessionId: action.session.id, name: action.name });
				ctx.ui.notify(renamed.text, "info");
			} else {
				const saved = await browserManager.execute({
					action: "save_profile",
					sessionId: action.session.id,
					targetProfile: action.profile,
				});
				ctx.ui.notify(saved.text, "info");
			}
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
		}
		await onChange?.();
		sessions = await listSessions();
		if (action.type === "create") selectedSessionId = sessions.find((candidate) => candidate.current)?.id ?? selectedSessionId;
		return sessions;
	};

	while (true) {
		const action = await showBrowserSessionsScreen(ctx, sessions, selectedSessionId, perform, pending);
		pending = undefined;
		if (action.type === "exit") return;
		if ("session" in action) selectedSessionId = action.session.id;

		// Every branch below either falls straight into the next screen with nothing awaited in
		// between — so the renderer coalesces the two and the editor is never painted — or hands the
		// manager a pending action to run once it is back on screen.
		if (action.type === "change-default-browser") {
			const selectedKey = await chooseDefaultBrowser(ctx, config);
			if (!selectedKey) continue;
			try {
				await writeProjectDefaultBrowser(ctx.cwd, config, selectedKey);
				config = loadConfig(ctx.cwd);
				browserManager.setConfig(config);
				const resolved = selectedKey === "system" ? ` (resolves to '${config.defaultBrowser}')` : "";
				ctx.ui.notify(`Default browser set to '${selectedKey}'${resolved}.`, "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
			continue;
		}

		if (action.type === "create-with-profile") {
			// Opening a browser asks nothing by default. Persistence is a deliberate choice, so only
			// the explicit "with profile" path shows the picker.
			const browserLabel = config.browsers[config.defaultBrowser]?.displayName ?? config.defaultBrowser;
			const profile = await chooseProfile(ctx, browserManager, config.defaultBrowser, browserLabel);
			if (!profile) continue;
			pending = { action: { type: "create", profile }, message: "Opening browser…" };
			continue;
		}

		if (action.type === "rename") {
			const name = await showNameEntryScreen(ctx, {
				title: `Rename Browser — ${action.session.displayName}`,
				confirmLabel: "rename",
				subject: "browser",
				context: "Shown in the Browser Manager and in tool output.",
				initial: action.session.name,
				taken: sessions.filter((session) => session.id !== action.session.id).map((session) => session.name),
			});
			if (!name || name === action.session.name) continue;
			pending = { action: { type: "rename", session: action.session, name }, message: "Renaming browser…" };
			continue;
		}

		if (action.type === "save") {
			const browserKey = action.session.browserKey;
			const profile = await showNameEntryScreen(ctx, {
				title: `Save Profile — ${action.session.displayName}`,
				confirmLabel: "save",
				subject: "profile",
				context: `${action.session.displayName} profile.`,
				initial: suggestProfileName([]),
				taken: [],
				// Which names are taken needs a manager call. Loading it against the mounted field
				// keeps the flow from stalling on the editor first.
				loadTaken: async () => {
					const listed = await browserManager.execute({ action: "list_profiles", browserKey });
					return ((listed.details.profiles as ProfileListEntry[] | undefined) ?? []).map((entry) => entry.profile);
				},
				suggest: suggestProfileName,
			});
			if (!profile) continue;
			pending = { action: { type: "save", session: action.session, profile }, message: "Saving profile…" };
		}
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
		if (data === "\x1bb" || data === "\x1bB") {
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
			"list_profiles",
			"rename_profile",
			"delete_profile",
			"save_profile",
			"start",
			"attach",
			"sessions",
			"show_session",
			"rename_session",
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
			"emulate",
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
	name: Type.Optional(Type.String({ description: "Friendly browser name shown in the browser manager" })),
	profile: Type.Optional(
		Type.String({
			description:
				"Saved profile to launch with. Omit it for a throwaway session whose cookies and logins are discarded when it closes — that is the right default for most tasks. A name that does not exist yet is created. Saved profiles are shared across projects, so use list_profiles first to see which are already running.",
		}),
	),
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
	device: Type.Optional(Type.String({ description: "Device preset for emulate, e.g. 'iPhone 13', 'Pixel 5', 'iPad Pro'. Sets viewport + touch + mobile UA + DPR" })),
	width: Type.Optional(Type.Number({ description: "Viewport width for emulate (use instead of device for a custom size)" })),
	height: Type.Optional(Type.Number({ description: "Viewport height for emulate" })),
	isMobile: Type.Optional(Type.Boolean({ description: "emulate: account for meta viewport (mobile rendering)" })),
	hasTouch: Type.Optional(Type.Boolean({ description: "emulate: enable touch events" })),
	deviceScaleFactor: Type.Optional(Type.Number({ description: "emulate: device scale factor / DPR (default 1)" })),
	userAgent: Type.Optional(Type.String({ description: "emulate: override the user-agent string for custom viewport" })),
	executablePath: Type.Optional(Type.String({ description: "Explicit browser executable path override" })),
	recordingId: Type.Optional(Type.String({ description: "Recording ID for record_stop" })),
	format: Type.Optional(StringEnum(["mp4", "webm", "gif"] as const)),
	fps: Type.Optional(Type.Number({ description: "Recording frame rate (default 10, max 30)" })),
	ffmpegPath: Type.Optional(Type.String({ description: "ffmpeg executable path or command (default ffmpeg)" })),
	workflowRecordingId: Type.Optional(Type.String({ description: "Workflow recording ID for workflow_record_stop" })),
	workflowId: Type.Optional(Type.String({ description: "Saved workflow ID for workflow_replay, workflow_rename, workflow_delete, or workflow_export" })),
	workflowName: Type.Optional(Type.String({ description: "Workflow name for recording or lookup" })),
	targetWorkflowName: Type.Optional(Type.String({ description: "New workflow name for workflow_rename" })),
	targetProfile: Type.Optional(Type.String({ description: "Profile name for rename_profile and save_profile" })),
	scriptFormat: Type.Optional(StringEnum(["puppeteer", "browser_tool"] as const)),
});

const WorkflowListToolSchema = Type.Object({});

const WorkflowReplayToolSchema = Type.Object({
	workflowId: Type.Optional(Type.String({ description: "Saved workflow ID" })),
	workflowName: Type.Optional(Type.String({ description: "Saved workflow name" })),
	sessionId: Type.Optional(Type.String({ description: "Browser session ID, like session-1" })),
	tabId: Type.Optional(Type.String({ description: "Tab ID, like tab-1" })),
	browserKey: Type.Optional(Type.String({ description: "Browser key used if a new session must be started" })),
	profile: Type.Optional(
		Type.String({ description: "Saved profile used if a new session must be started. Omit for a throwaway session." }),
	),
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
		const startupConfig = loadConfig(ctx.cwd);
		manager = new BrowserManager(ctx.cwd, startupConfig);
		reportProfileMigration(ctx, startupConfig);
		// A throwaway profile is removed when its session closes, but a crash or a killed terminal skips
		// that and leaves a few hundred megabytes behind. Sweeping on start is the backstop; it probes
		// each candidate for a live browser, so it must not hold up the session.
		void sweepTemporaryProfiles(startupConfig.profileRoot).catch(() => undefined);
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
		description: "Interact with a configured browser session. Supports launch, attach, navigation, clicks, typing, scrolling, device/mobile emulation, screenshots, text extraction, inspection, ffmpeg-backed page recording, and saved workflow recording/replay.",
		promptSnippet: "Launch or attach to configured browsers, navigate pages, inspect page state, capture screenshots, and record MP4/WebM/GIF clips.",
		promptGuidelines: [
			"Use browser when the user wants Pi to interact with websites, tabs, forms, screenshots, or page inspection.",
			"Use browser start or browser attach before page actions when no browser session is open.",
			"Use browser inspect or browser extract_text instead of dumping large page HTML into context.",
			"Use workflow_list, workflow_replay, and workflow_details for saved workflow execution; use browser workflow_record_start/workflow_record_stop to record new workflows.",
			"Sessions started without a profile are throwaway: nothing they sign in to survives the session. Start one whenever persistence is not the point, and pass a profile only when a signed-in state has to outlive the browser.",
			"Every start without a profile opens a separate browser. Keep working through the sessionId you already have rather than calling start again.",
			"Use save_profile with a targetProfile to keep a throwaway session's signed-in state. It applies immediately and the browser keeps running, so it is the right answer after signing in to something worth reusing. Ask the user before saving: a saved profile persists credentials on disk.",
			"Saved profiles are shared across projects. Use browser list_profiles before starting a session on one: starting on a profile that is already running connects to that browser instead of opening a new window.",
			"Use rename_profile and delete_profile to manage saved profiles. rename_profile works while a browser is running; delete_profile does not, and permanently discards the profile's signed-in sessions, so confirm with the user first.",
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
