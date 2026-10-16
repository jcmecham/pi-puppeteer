import { ProtocolError } from "puppeteer-core";
import type { Page, Viewport } from "puppeteer-core";

/**
 * Make `emulate` work on a Firefox that predates the `emulation.*` BiDi commands.
 *
 * Puppeteer's BiDi `setViewport` issues three commands at once:
 *
 *     await Promise.all([
 *       browsingContext.setViewport({ viewport, devicePixelRatio }),
 *       browsingContext.setScreenOrientationOverride(orientation),
 *       browsingContext.setTouchOverride(maxTouchPoints),   // only on a touch change
 *     ]);
 *
 * It already tolerates `unknown command` from the touch one, but the orientation override is
 * unconditional — and Firefox only grew `emulation.setScreenOrientationOverride` in 144 and
 * `emulation.setUserAgentOverride` in 145. On anything older the whole `Promise.all` rejects.
 *
 * The rejection is the entire problem, not the missing feature. `browsingContext.setViewport` is old
 * enough to exist all the way back through the 140 ESR line and it succeeds on its own — but because
 * it was awaited alongside a command that threw, the size is never applied. Measured on 140.0esr:
 * before `1366x634`, after the throw still `1366x634`, and the same call issued by itself gives
 * exactly the size asked for.
 *
 * So the fallback re-issues the one command that works, and reports the parts that genuinely could
 * not be honoured rather than pretending they were. Resizing the viewport is the whole point of
 * `emulate` for anyone checking a mobile layout; screen orientation and a spoofed user agent are
 * refinements, and losing them silently would be worse than losing them out loud.
 *
 * Firefox ≥ 145 never reaches any of this — `page.setViewport` succeeds and the fallback is dead
 * code on a current browser.
 */

/** What the browser could not honour, in words a user can act on. */
export interface EmulationOutcome {
	skipped: string[];
}

/** Firefox's wording for a command its build predates, e.g. `emulation.setScreenOrientationOverride`. */
const UNKNOWN_COMMAND = /unknown command ([A-Za-z]+\.[A-Za-z]+)/;

/**
 * The BiDi command name a protocol error is complaining about, or undefined for any other failure.
 *
 * Kept deliberately literal: it matches Firefox's own phrasing rather than guessing from an error
 * class, because a genuine bug and a missing command arrive as the same `ProtocolError` type.
 */
export function unknownProtocolCommand(error: unknown): string | undefined {
	if (!(error instanceof ProtocolError)) return undefined;
	return UNKNOWN_COMMAND.exec(error.message)?.[1];
}

/** Narrower: only the `emulation.*` commands this module knows how to work around. */
export function unknownEmulationCommand(error: unknown): string | undefined {
	const command = unknownProtocolCommand(error);
	return command?.startsWith("emulation.") ? command : undefined;
}

/**
 * The private handle puppeteer uses for the frame's BiDi browsing context.
 *
 * Reaching past the public API is deliberate and deliberately narrow. Puppeteer exposes no way to
 * set a viewport without also setting the screen orientation, and the alternative — telling the user
 * their browser is too old for the one action they came for — is worse. Shaped as a lookup that
 * returns undefined rather than a cast that assumes, so a future puppeteer that renames this fails
 * over to the original error instead of throwing something unrecognisable.
 */
function browsingContextOf(page: Page): { setViewport(options: unknown): Promise<void> } | undefined {
	const frame = page.mainFrame() as unknown as {
		browsingContext?: { setViewport?: unknown };
	};
	const context = frame.browsingContext;
	if (!context || typeof context.setViewport !== "function") return undefined;
	return context as { setViewport(options: unknown): Promise<void> };
}

/**
 * Apply a viewport, falling back to the size alone when the browser has no `emulation.*` commands.
 *
 * Throws the original protocol error when the fallback is not available, so a genuine failure still
 * reads like one.
 */
export async function applyViewport(page: Page, viewport: Viewport): Promise<EmulationOutcome> {
	try {
		await page.setViewport(viewport);
		return { skipped: [] };
	} catch (error) {
		if (!unknownEmulationCommand(error)) throw error;

		const context = browsingContextOf(page);
		if (!context) throw error;

		await context.setViewport({
			viewport: { width: viewport.width, height: viewport.height },
			devicePixelRatio: viewport.deviceScaleFactor ?? null,
		});

		// devicePixelRatio travels with the command that worked, so it survives and needs no mention.
		const skipped = ["screen orientation"];
		// Touch rides along with the viewport in puppeteer's call, so it is gone here too — but only
		// say so when it was actually asked for.
		if (viewport.hasTouch) skipped.push("touch emulation");
		return { skipped };
	}
}

/** Apply a user agent override, reporting rather than throwing when the browser has no such command. */
export async function applyUserAgent(page: Page, userAgent: string): Promise<EmulationOutcome> {
	try {
		await page.setUserAgent(userAgent);
		return { skipped: [] };
	} catch (error) {
		if (!unknownEmulationCommand(error)) throw error;
		return { skipped: ["user agent"] };
	}
}

/** The Firefox that first shipped each emulation command, for the note below. */
const SUPPORTED_FROM: Record<string, number> = {
	"screen orientation": 144,
	"touch emulation": 144,
	"user agent": 145,
};

/**
 * Turn skipped parts into a sentence, naming the fix.
 *
 * The version is worth stating: "your Firefox is too old" is only useful with a number attached. Only
 * the versions that bear on what was actually skipped get mentioned — telling someone about the touch
 * cutoff when they asked for a user agent is noise.
 */
export function emulationSkipNote(skipped: string[]): string {
	if (skipped.length === 0) return "";
	const list = skipped.length === 1 ? skipped[0] : `${skipped.slice(0, -1).join(", ")} and ${skipped.at(-1)}`;
	const needed = Math.max(...skipped.map((part) => SUPPORTED_FROM[part] ?? 145));
	return ` The viewport size was applied, but this Firefox is too old to emulate ${list} — that needs Firefox ${needed} or newer.`;
}
