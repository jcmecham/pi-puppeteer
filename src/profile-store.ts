import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { ProfileOwner, ProfileState } from "./profile-lock.ts";
import { inspectProfile } from "./profile-lock.ts";

// A profile's *identity* used to be its directory name: `profiles/chrome/work` was the profile called
// "work". That made saving a running throwaway session impossible without a restart, because renaming
// meant moving a live --user-data-dir: Windows refuses with EPERM/EBUSY while a browser holds handles
// inside it, and POSIX lets the rename succeed but then Chromium cannot create new files at the old
// path it still has cached. Copying it live is worse — the Cookies and Local State SQLite databases can
// be caught mid-transaction and the corruption is silent until the profile is next opened.
//
// So the directory name is now an opaque ID and the display name lives in a sidecar next to
// `.pi-puppeteer-owner.json`. Saving or renaming is one small JSON write; nothing on disk moves and the
// browser never notices.
//
// This file owns profile identity the way profile-lock.ts owns profile ownership.

const PROFILE_FILE = ".pi-puppeteer-profile.json";
/** Prefix on throwaway directory names. Cosmetic: it makes the profile root readable, and nothing
 * infers anything from it — a saved profile is free to be called "tmp-scratch". */
const TEMPORARY_PREFIX = "tmp-";

export interface ProfileMeta {
	schemaVersion: 1;
	id: string;
	/** Display name, stored verbatim: the ID carries the path-safety burden, so this need not. */
	name: string;
	temporary: boolean;
	browserKey: string;
	createdAt: number;
}

// Profile IDs become path segments under a shared root, so `.` and `..` must never survive: an ID of
// ".." would resolve outside the profile root and into the Pi agent directory.
export function sanitizeSegment(value: string | undefined, fallback: string): string {
	const base = (value ?? fallback).trim() || fallback;
	const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
	return cleaned || fallback;
}

// Profile roots live under the Pi agent directory, so a crafted segment escaping the root would land in
// Pi's own configuration. Sanitizing is the first line of defence; this is the second.
export function assertInsideRoot(root: string, candidate: string): void {
	const prefix = resolve(root) + sep;
	if (!resolve(candidate).startsWith(prefix)) {
		throw new Error("Resolved profile path escapes the profile root.");
	}
}

export function profileMetaPath(userDataDir: string): string {
	return join(userDataDir, PROFILE_FILE);
}

export function readProfileMeta(userDataDir: string): ProfileMeta | undefined {
	try {
		const meta = JSON.parse(readFileSync(profileMetaPath(userDataDir), "utf8")) as ProfileMeta;
		return typeof meta?.name === "string" && typeof meta?.temporary === "boolean" ? meta : undefined;
	} catch {
		return undefined;
	}
}

export function writeProfileMeta(userDataDir: string, meta: ProfileMeta): void {
	writeFileSync(profileMetaPath(userDataDir), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/**
 * Read a profile's identity, inventing one for a directory that predates the sidecar.
 *
 * Profiles created before this version *are* named by their directory, so the upgrade is to treat that
 * name as both the ID and the display name and write it down. Nothing is renamed or moved: the point of
 * the sidecar is that a directory name never has to change again.
 */
export function ensureProfileMeta(userDataDir: string, browserKey: string): ProfileMeta {
	const existing = readProfileMeta(userDataDir);
	if (existing) return existing;

	// Always saved. A directory with no sidecar predates them, and everything that predates them was
	// a profile someone named and kept. Guessing from the directory name instead would let the sweep
	// delete a pre-existing profile that happened to be called "tmp-something", and a throwaway
	// directory cannot reach this path anyway: allocateTemporaryProfile writes its sidecar as part of
	// creating it, and throws rather than leaving one behind unlabelled.
	const id = basename(userDataDir);
	const meta: ProfileMeta = {
		schemaVersion: 1,
		id,
		name: id,
		temporary: false,
		browserKey,
		createdAt: Date.now(),
	};
	try {
		writeProfileMeta(userDataDir, meta);
	} catch {
		// A profile we cannot annotate still reads correctly from the values above; persisting is an
		// optimisation, not a requirement, and must never fail a launch or a listing.
	}
	return meta;
}

function browserRoot(profileRoot: string, browserKey: string): string {
	const dir = join(profileRoot, sanitizeSegment(browserKey, "browser"));
	assertInsideRoot(profileRoot, dir);
	return dir;
}

function directoryNames(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** Every profile directory for one browser, with its identity resolved. */
export function listProfileMeta(profileRoot: string, browserKey: string): Array<{ dir: string; meta: ProfileMeta }> {
	const root = browserRoot(profileRoot, browserKey);
	return directoryNames(root).map((id) => {
		const dir = join(root, id);
		return { dir, meta: ensureProfileMeta(dir, browserKey) };
	});
}

/**
 * Create a throwaway profile directory.
 *
 * Each one is unique, which is what lets several throwaway browsers run at once: Chromium allows only
 * one process per --user-data-dir, so the single shared "default" profile the old flow used made a
 * second concurrent browser impossible.
 */
export function allocateTemporaryProfile(profileRoot: string, browserKey: string): { dir: string; meta: ProfileMeta } {
	const root = browserRoot(profileRoot, browserKey);
	let dir: string;
	do {
		const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		dir = join(root, `${TEMPORARY_PREFIX}${suffix}`);
	} while (existsSync(dir));
	assertInsideRoot(profileRoot, dir);

	mkdirSync(dir, { recursive: true });
	const meta: ProfileMeta = {
		schemaVersion: 1,
		id: basename(dir),
		name: basename(dir),
		temporary: true,
		browserKey,
		createdAt: Date.now(),
	};
	writeProfileMeta(dir, meta);
	return { dir, meta };
}

/** Create a saved profile. The ID is derived from the name so paths stay readable, but never moves after. */
export function allocateSavedProfile(profileRoot: string, browserKey: string, name: string): { dir: string; meta: ProfileMeta } {
	const root = browserRoot(profileRoot, browserKey);
	const base = sanitizeSegment(name, "profile");
	let id = base;
	let suffix = 2;
	while (existsSync(join(root, id))) {
		id = `${base}-${suffix}`;
		suffix += 1;
	}

	const dir = join(root, id);
	assertInsideRoot(profileRoot, dir);
	mkdirSync(dir, { recursive: true });
	const meta: ProfileMeta = {
		schemaVersion: 1,
		id,
		name: name.trim() || id,
		temporary: false,
		browserKey,
		createdAt: Date.now(),
	};
	writeProfileMeta(dir, meta);
	return { dir, meta };
}

/** Find a saved profile by its display name. Matching is case-insensitive, the way the pickers compare. */
export function resolveProfileByName(
	profileRoot: string,
	browserKey: string,
	name: string,
): { dir: string; meta: ProfileMeta } | undefined {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return undefined;
	return listProfileMeta(profileRoot, browserKey).find(
		(entry) => !entry.meta.temporary && entry.meta.name.toLowerCase() === wanted,
	);
}

/**
 * Promote a throwaway profile to a saved one, or rename a saved one.
 *
 * This is the whole reason the sidecar exists: it is a single file write, so it works while a browser is
 * running on the profile and needs no restart, no copy, and no window to close.
 */
export function nameProfile(userDataDir: string, browserKey: string, name: string): ProfileMeta {
	const meta = ensureProfileMeta(userDataDir, browserKey);
	const next: ProfileMeta = { ...meta, name: name.trim() || meta.id, temporary: false };
	writeProfileMeta(userDataDir, next);
	return next;
}

/**
 * Delete throwaway profile directories no browser is using.
 *
 * A throwaway profile is removed when its session closes, but a crash or a killed terminal skips that.
 * The sidecar makes the judgement certain rather than a guess: `temporary` says the data was never
 * meant to survive, and a `free` result from inspectProfile says nothing is still writing to it.
 */
export async function sweepTemporaryProfiles(profileRoot: string): Promise<string[]> {
	const swept: string[] = [];
	for (const browserKey of directoryNames(profileRoot)) {
		for (const { dir, meta } of listProfileMeta(profileRoot, browserKey)) {
			if (!meta.temporary) continue;
			const state = await inspectProfile(dir);
			if (state.state !== "free") continue;
			try {
				rmSync(dir, { recursive: true, force: true });
				swept.push(dir);
			} catch {
				// A directory Windows still has handles into is left for the next sweep.
			}
		}
	}
	return swept;
}

/** Remove one throwaway profile directory, used when its session ends. */
export function discardProfile(userDataDir: string): void {
	try {
		rmSync(userDataDir, { recursive: true, force: true });
	} catch {
		// Best effort: the startup sweep is the backstop.
	}
}

export interface DiscoveredProfile {
	browserKey: string;
	/** Directory name. Opaque; see the note at the top of this file for why it is not the display name. */
	id: string;
	/** Display name shown in pickers and accepted by the `profile` input. */
	profile: string;
	temporary: boolean;
	path: string;
	state: ProfileState["state"];
	/** Set when a browser is live or starting on this profile. */
	owner?: ProfileOwner;
	/** Set for a live Chromium profile. */
	browserURL?: string;
	/** Set for a live Firefox profile, which has no HTTP endpoint to report. */
	browserWSEndpoint?: string;
	/** Firefox only: false when its one WebDriver session is already attached. */
	sessionAvailable?: boolean;
	lastUsedAt?: number;
}

function lastUsedAt(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * List every profile under a profile root along with whether a browser is currently running on it.
 *
 * Profiles are shared across projects, so "is this one in use?" can only be answered by looking at
 * the profile itself. Probes run concurrently: each one may wait on a network timeout, and a root
 * can hold a dozen profiles.
 */
export async function discoverProfiles(
	profileRoot: string,
	browserKey?: string,
	options: { includeTemporary?: boolean } = {},
): Promise<DiscoveredProfile[]> {
	const browserKeys = browserKey ? [browserKey] : directoryNames(profileRoot);

	// Throwaway profiles are an implementation detail of a running session, not something to offer in a
	// picker or report to the agent, so they are excluded unless explicitly asked for.
	const candidates = browserKeys.flatMap((key) =>
		listProfileMeta(profileRoot, key)
			.filter((entry) => options.includeTemporary || !entry.meta.temporary)
			.map((entry) => ({
				browserKey: key,
				id: entry.meta.id,
				profile: entry.meta.name,
				temporary: entry.meta.temporary,
				path: entry.dir,
			})),
	);

	const discovered = await Promise.all(
		candidates.map(async (candidate): Promise<DiscoveredProfile> => {
			const state = await inspectProfile(candidate.path);
			return {
				...candidate,
				state: state.state,
				owner: state.state === "free" ? undefined : state.owner,
				browserURL: state.state === "live" && state.engine === "chromium" ? state.browserURL : undefined,
				browserWSEndpoint: state.state === "live" && state.engine === "firefox" ? state.browserWSEndpoint : undefined,
				sessionAvailable: state.state === "live" && state.engine === "firefox" ? state.sessionAvailable : undefined,
				lastUsedAt: lastUsedAt(candidate.path),
			};
		}),
	);

	// Running profiles first, then most recently used, so the interesting entries lead.
	return discovered.sort((left, right) => {
		const liveDelta = Number(right.state !== "free") - Number(left.state !== "free");
		return liveDelta !== 0 ? liveDelta : (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0);
	});
}
