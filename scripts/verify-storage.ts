import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Storage layout checks for the profile roots and the migration in src/config.ts. The repository has
// no unit-test framework, and `tsc --noEmit` cannot see any of this behaviour, so this harness runs
// the real loadConfig against synthetic project trees under the OS temp directory.
//
//   npx tsx scripts/verify-storage.ts

const ROOT = join(tmpdir(), `pi-puppeteer-verify-${process.pid}`);
const AGENT_DIR = join(ROOT, "agent");

// getAgentDir() is captured at module load, so the override has to be set before the import below.
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(AGENT_DIR, { recursive: true });

const { loadConfig } = await import("../src/config.ts");

const GLOBAL_PROFILES = join(AGENT_DIR, "extensions", "pi-puppeteer", "profiles");
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "  ok  " : " FAIL "} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
	if (!ok) failures += 1;
}

// Each case needs its own directory: migration memoizes per resolved cwd for the process lifetime.
function project(name: string): string {
	const dir = join(ROOT, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function storagePath(cwd: string, ...segments: string[]): string {
	return join(cwd, ".pi", ".pi-puppeteer", ...segments);
}

function seedProfile(cwd: string, browser: string, profile: string, contents: string): string {
	const dir = storagePath(cwd, "profiles", browser, profile);
	mkdirSync(join(dir, "Default"), { recursive: true });
	writeFileSync(join(dir, "Default", "Cookies"), contents, "utf8");
	return dir;
}

function writeSettings(cwd: string, settings: Record<string, unknown>): void {
	mkdirSync(storagePath(cwd), { recursive: true });
	writeFileSync(storagePath(cwd, "settings.json"), JSON.stringify(settings), "utf8");
}

console.log("storage layout");

// Starting Pi in a directory must leave no trace. This guards the eager-mkdir regression.
{
	const cwd = project("fresh");
	loadConfig(cwd);
	check("fresh directory stays untouched", !existsSync(join(cwd, ".pi")));
}

{
	const cwd = project("defaults");
	const config = loadConfig(cwd);
	check("profiles default to the global root", config.profileRoot === GLOBAL_PROFILES, config.profileRoot);
	check("profile scope defaults to global", config.profileScope === "global", config.profileScope);
	check("artifacts stay project-local", config.artifactRoot === storagePath(cwd, "artifacts"), config.artifactRoot);
}

console.log("\nmigration");

{
	const cwd = project("migrate");
	seedProfile(cwd, "chrome", "default", "FIRST");
	const config = loadConfig(cwd);
	const moved = join(GLOBAL_PROFILES, "chrome", "default", "Default", "Cookies");
	check("profile moves to the global root", existsSync(moved));
	check("profile contents survive", existsSync(moved) && readFileSync(moved, "utf8") === "FIRST");
	check("project profiles directory is removed", !existsSync(storagePath(cwd, "profiles")));
	check("the move is reported", config.profileMigration?.moved.length === 1, JSON.stringify(config.profileMigration));
	check("an ignore file is written", readFileSync(storagePath(cwd, ".gitignore"), "utf8") === "*\n!.gitignore\n");
}

// The corruption guard: two projects owning a same-named profile must never be merged into one.
{
	const cwd = project("collision");
	seedProfile(cwd, "chrome", "default", "SECOND");
	const config = loadConfig(cwd);
	const global = join(GLOBAL_PROFILES, "chrome", "default", "Default", "Cookies");
	const local = storagePath(cwd, "profiles", "chrome", "default", "Default", "Cookies");
	check("the existing global profile is untouched", readFileSync(global, "utf8") === "FIRST", readFileSync(global, "utf8"));
	check("the colliding profile stays in the project", existsSync(local) && readFileSync(local, "utf8") === "SECOND");
	check("the collision is reported", config.profileMigration?.pending[0]?.reason === "target-exists", JSON.stringify(config.profileMigration));
	check("nothing is reported as moved", config.profileMigration?.moved.length === 0);
}

// A profile a browser still holds open must be deferred whole, never partially copied.
{
	const cwd = project("locked");
	const dir = seedProfile(cwd, "edge", "work", "LOCKED");
	writeFileSync(join(dir, "SingletonLock"), "", "utf8");
	const config = loadConfig(cwd);
	check("an in-use profile is deferred", config.profileMigration?.pending[0]?.reason === "locked", JSON.stringify(config.profileMigration));
	check("the source is left intact", existsSync(join(dir, "Default", "Cookies")));
	check("no partial copy reaches the global root", !existsSync(join(GLOBAL_PROFILES, "edge", "work")));
}

{
	const cwd = project("repeat");
	seedProfile(cwd, "brave", "solo", "SOLO");
	const first = loadConfig(cwd);
	const second = loadConfig(cwd);
	check("the first load reports the move", first.profileMigration?.moved.length === 1);
	check("later loads stay silent", second.profileMigration === undefined);
}

console.log("\nconfiguration");

{
	const cwd = project("scoped");
	seedProfile(cwd, "chrome", "kept", "KEPT");
	writeSettings(cwd, { profileScope: "project" });
	const config = loadConfig(cwd);
	check('profileScope "project" keeps profiles local', config.profileRoot === storagePath(cwd, "profiles"), config.profileRoot);
	check('profileScope "project" skips migration', config.profileMigration === undefined);
	check("the local profile is left alone", existsSync(storagePath(cwd, "profiles", "chrome", "kept", "Default", "Cookies")));
}

{
	const cwd = project("legacy-value");
	writeSettings(cwd, { profileRoot: ".pi/.pi-puppeteer/profiles" });
	check("the old default profileRoot is upgraded", loadConfig(cwd).profileRoot === GLOBAL_PROFILES);
}

{
	const cwd = project("custom-value");
	const custom = join(ROOT, "elsewhere");
	writeSettings(cwd, { profileRoot: custom });
	const config = loadConfig(cwd);
	check("a custom profileRoot is honoured verbatim", config.profileRoot === custom, config.profileRoot);
	check("a custom profileRoot skips migration", config.profileMigration === undefined);
}

console.log("\nprofile discovery");

const { discoverProfiles } = await import("../src/profile-lock.ts");

{
	const root = join(ROOT, "discovery");
	mkdirSync(join(root, "edge", "work"), { recursive: true });
	mkdirSync(join(root, "edge", "scratch"), { recursive: true });
	mkdirSync(join(root, "chrome", "default"), { recursive: true });

	const all = await discoverProfiles(root);
	check("every profile is found across browsers", all.length === 3, JSON.stringify(all.map((entry) => `${entry.browserKey}/${entry.profile}`)));
	check("profiles with no browser read as free", all.every((entry) => entry.state === "free"));

	const scoped = await discoverProfiles(root, "edge");
	check("discovery can be scoped to one browser", scoped.length === 2 && scoped.every((entry) => entry.browserKey === "edge"));

	// A dead owner must not make a profile look busy forever. Pid 1 is never this process, and the
	// record is rejected outright on a hostname mismatch.
	writeFileSync(
		join(root, "edge", "work", ".pi-puppeteer-owner.json"),
		JSON.stringify({ pid: 1, browserURL: "http://127.0.0.1:1", browserKey: "edge", profile: "work", cwd: root, startedAt: 0, host: "not-this-host", state: "ready" }),
		"utf8",
	);
	const stale = await discoverProfiles(root, "edge");
	check("a stale ownership record does not mark a profile busy", stale.every((entry) => entry.state === "free"), JSON.stringify(stale));
	check("the stale record is cleaned up", !existsSync(join(root, "edge", "work", ".pi-puppeteer-owner.json")));

	// An unreachable DevTools port is not evidence of a live browser either.
	writeFileSync(join(root, "edge", "scratch", "DevToolsActivePort"), "1\n/devtools/browser/x", "utf8");
	const deadPort = await discoverProfiles(root, "edge");
	check("an unreachable DevTools port reads as free", deadPort.every((entry) => entry.state === "free"), JSON.stringify(deadPort));
}

console.log("\nprofile management");

{
	const { BrowserManager } = await import("../src/manager.ts");
	const cwd = project("manage");
	const config = loadConfig(cwd);
	const manager = new BrowserManager(cwd, config);

	// Any discovered browser works; these actions never launch one.
	const browserKey = Object.keys(config.browsers)[0]!;
	const profileDir = (name: string) => join(GLOBAL_PROFILES, browserKey, name);
	mkdirSync(profileDir("idle"), { recursive: true });
	writeFileSync(join(profileDir("idle"), "marker"), "KEEP", "utf8");
	mkdirSync(profileDir("taken"), { recursive: true });

	async function failsWith(name: string, run: () => Promise<unknown>, needle: string): Promise<void> {
		try {
			await run();
			check(name, false, "no error was thrown");
		} catch (error) {
			const message = (error as Error).message;
			check(name, message.includes(needle), message);
		}
	}

	await manager.execute({ action: "rename_profile", browserKey, profile: "idle", targetProfile: "renamed" });
	check("rename moves the profile directory", existsSync(join(profileDir("renamed"), "marker")) && !existsSync(profileDir("idle")));

	await failsWith(
		"rename refuses an existing target",
		() => manager.execute({ action: "rename_profile", browserKey, profile: "renamed", targetProfile: "taken" }),
		"already exists",
	);
	await failsWith(
		"rename refuses an unknown profile",
		() => manager.execute({ action: "rename_profile", browserKey, profile: "nope", targetProfile: "x" }),
		"No profile",
	);
	await failsWith(
		"rename refuses a blank new name",
		() => manager.execute({ action: "rename_profile", browserKey, profile: "renamed", targetProfile: "   " }),
		"new profile name is required",
	);

	// A traversal attempt is sanitized into a safe name rather than rejected; the containment assert
	// in the manager is the backstop.
	await manager.execute({ action: "rename_profile", browserKey, profile: "renamed", targetProfile: "../escaped" });
	check("rename sanitizes a traversal into the profile root", existsSync(profileDir("escaped")));
	check("rename writes nothing outside the profile root", !existsSync(join(GLOBAL_PROFILES, "..", "escaped")));

	const deleted = await manager.execute({ action: "delete_profile", browserKey, profile: "taken" });
	check("delete removes the profile directory", !existsSync(profileDir("taken")));
	check("delete warns that signed-in sessions are lost", deleted.text.includes("signing in"), deleted.text);
	await failsWith(
		"delete refuses an unknown profile",
		() => manager.execute({ action: "delete_profile", browserKey, profile: "gone" }),
		"No profile",
	);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
