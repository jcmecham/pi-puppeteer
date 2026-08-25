import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

// Behavioural checks for storage layout, profile discovery and management, and screen geometry. The
// repository has no unit-test framework and `tsc --noEmit` sees none of this, so the harness runs the
// real code against synthetic project trees under the OS temp directory.
//
//   npx tsx scripts/verify.ts

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
//
// The marker has to be genuinely unavailable, not merely present: a browser that exited leaves its
// lock files behind, and treating those as proof of life is what used to wedge migration forever. On
// Windows a read-only marker produces the same EPERM an exclusively held one does; on POSIX an fcntl
// lock cannot be observed at all, so a bare marker already counts as held.
{
	const cwd = project("locked");
	const dir = seedProfile(cwd, "edge", "work", "LOCKED");
	const marker = join(dir, "SingletonLock");
	writeFileSync(marker, "", "utf8");
	if (process.platform === "win32") chmodSync(marker, 0o444);

	const config = loadConfig(cwd);
	check("an in-use profile is deferred", config.profileMigration?.pending[0]?.reason === "locked", JSON.stringify(config.profileMigration));
	check("the source is left intact", existsSync(join(dir, "Default", "Cookies")));
	check("no partial copy reaches the global root", !existsSync(join(GLOBAL_PROFILES, "edge", "work")));

	// Let the teardown at the bottom of this file remove it again.
	if (process.platform === "win32") chmodSync(marker, 0o666);
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

const { discoverProfiles } = await import("../src/profile-store.ts");

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

	const renamed = await manager.execute({ action: "rename_profile", browserKey, profile: "idle", targetProfile: "renamed" });
	// The whole point of the sidecar: a rename is a name change, not a directory move, so it stays safe
	// while a browser holds the profile open.
	check("rename leaves the directory exactly where it was", existsSync(join(profileDir("idle"), "marker")));
	check("rename reports the original path", renamed.details.path === profileDir("idle"), String(renamed.details.path));
	check("the renamed profile is found under its new name", (await discoverProfiles(GLOBAL_PROFILES, browserKey)).some((entry) => entry.profile === "renamed"));
	check("the old name no longer resolves", !(await discoverProfiles(GLOBAL_PROFILES, browserKey)).some((entry) => entry.profile === "idle"));

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

	// A display name is stored verbatim, so a traversal in one is inert: it never reaches a path.
	await manager.execute({ action: "rename_profile", browserKey, profile: "renamed", targetProfile: "../escaped" });
	check("a traversal in a display name never becomes a directory", !existsSync(join(GLOBAL_PROFILES, "..", "escaped")) && !existsSync(profileDir("escaped")));
	check("the profile still lives in its original directory", existsSync(join(profileDir("idle"), "marker")));
	await manager.execute({ action: "rename_profile", browserKey, profile: "../escaped", targetProfile: "renamed" });

	const deleted = await manager.execute({ action: "delete_profile", browserKey, profile: "taken" });
	check("delete removes the profile directory", !existsSync(profileDir("taken")));
	check("delete warns that signed-in sessions are lost", deleted.text.includes("signing in"), deleted.text);
	await failsWith(
		"delete refuses an unknown profile",
		() => manager.execute({ action: "delete_profile", browserKey, profile: "gone" }),
		"No profile",
	);
}

console.log("\nprofile lock detection");

{
	const { browserHoldsProfile, browserProvablyHoldsProfile } = await import("../src/profile-lock.ts");

	const root = join(ROOT, "locks");
	const dir = (name: string) => {
		const path = join(root, name);
		mkdirSync(path, { recursive: true });
		return path;
	};

	check("a profile with no lock files is free", !browserHoldsProfile(dir("clean")));

	// The regression this check exists for. Firefox creates parent.lock once and never removes it, so
	// testing for the file alone reported every Firefox profile that had ever run as permanently in
	// use — a migration that could never finish and a warning no user action could clear.
	const stale = dir("firefox-exited");
	writeFileSync(join(stale, "parent.lock"), "", "utf8");
	check(
		"a leftover parent.lock nobody holds is not in use",
		process.platform === "win32" ? !browserHoldsProfile(stale) : browserHoldsProfile(stale),
		"on POSIX an fcntl lock is undetectable, so unprovable still counts as in use",
	);
	check("...and unprovable is never mistaken for proof", !browserProvablyHoldsProfile(stale));

	// A lock symlink outlives a crash, so the pid it names is what decides. A genuinely dead pid has
	// to be earned: pid 1 is alive and root-owned, and `kill(1, 0)` answers EPERM, which means "exists,
	// not yours" rather than "gone". spawnSync returns only once the child has exited and been reaped,
	// so its pid names a process that is really over. The current pid stands in for a live one.
	if (process.platform !== "win32") {
		const { symlinkSync } = await import("node:fs");
		const { spawnSync } = await import("node:child_process");
		const reaped = spawnSync(process.execPath, ["-e", ""]);
		const deadPid = reaped.pid;
		check("a throwaway child process could be reaped for its pid", typeof deadPid === "number" && deadPid > 0, String(reaped.error));

		const dead = dir("chromium-crashed");
		symlinkSync(`somehost-${deadPid}`, join(dead, "SingletonLock"));
		check("a lock symlink naming a dead pid is not in use", !browserHoldsProfile(dead));

		const live = dir("chromium-running");
		symlinkSync(`somehost-${process.pid}`, join(live, "SingletonLock"));
		check("a lock symlink naming a live pid is in use", browserHoldsProfile(live));

		const firefoxLive = dir("firefox-running");
		symlinkSync(`127.0.1.1:+${process.pid}`, join(firefoxLive, "lock"));
		check("Firefox's ip:+pid lock target is understood", browserHoldsProfile(firefoxLive));

		const unparseable = dir("unparseable");
		symlinkSync("no-pid-here", join(unparseable, "SingletonLock"));
		check("an unreadable lock target counts as in use on POSIX", browserHoldsProfile(unparseable));

		check("a live lock symlink is proof, not a guess", browserProvablyHoldsProfile(live));
		check("a dead lock symlink proves nothing", !browserProvablyHoldsProfile(dead));
		check("an unreadable lock target proves nothing either", !browserProvablyHoldsProfile(unparseable));

		// The regression the launch gate exists to avoid, in the shape Firefox actually leaves behind:
		// `.parentlock` is a plain file it fcntl-locks and never unlinks, so on POSIX it survives every
		// clean exit. Read as "in use" it would refuse to launch any profile that had ever run Firefox.
		const firefoxExited = dir("firefox-exited-posix");
		writeFileSync(join(firefoxExited, ".parentlock"), "", "utf8");
		check("a Firefox that ran and exited can be launched again", !browserProvablyHoldsProfile(firefoxExited));
		check(
			"...while the same profile is still too risky to rename or delete",
			browserHoldsProfile(firefoxExited),
			"the cautious answer has to stay cautious for its own caller",
		);
	}
}

console.log("\nprofile process detection");

{
	const { browserProcessOnProfile, FIREFOX_PROFILE_ARG } = await import("../src/adapters/reap.ts");
	const { spawn } = await import("node:child_process");

	// What the launch gate falls back to when the lock files cannot say. Stand in for Firefox with a
	// node that idles under the same `--profile <dir>` argument, since the matcher reads a command
	// line and does not care what wrote it.
	const held = join(ROOT, "process-held");
	mkdirSync(held, { recursive: true });
	const free = join(ROOT, "process-free");
	mkdirSync(free, { recursive: true });

	// `--` first, or node claims `--profile` as one of its own options and exits before it can stand in
	// for anything. The command line still reads `--profile <dir>`, which is all the matcher looks at.
	const idle = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", "--", "--profile", held], {
		stdio: "ignore",
	});
	const exited = new Promise<void>((resolve) => idle.on("exit", () => resolve()));
	// Give the process list a moment to show a process that was spawned microseconds ago.
	await new Promise((resolve) => setTimeout(resolve, 500));

	check("a process holding the profile is found", await browserProcessOnProfile(held, FIREFOX_PROFILE_ARG));
	check("a profile nothing is running on is not", !(await browserProcessOnProfile(free, FIREFOX_PROFILE_ARG)));

	idle.kill();
	await exited;
	check("and it is gone once the process is", !(await browserProcessOnProfile(held, FIREFOX_PROFILE_ARG)));
}

console.log("\nfirefox endpoint normalization");

{
	const { normalizeFirefoxEndpoint } = await import("../src/adapters/firefox.ts");

	const rows: Array<[string, string]> = [
		["ws://127.0.0.1:9222", "ws://127.0.0.1:9222/session"],
		["ws://127.0.0.1:9222/", "ws://127.0.0.1:9222/session"],
		["ws://127.0.0.1:9222/session", "ws://127.0.0.1:9222/session"],
		["wss://example.test:9222/session", "wss://example.test:9222/session"],
		// The row that matters: --remote-debugging-port reads like an HTTP thing, and every other
		// browser in the config is attached to over http://, so this is the likeliest thing to type.
		["http://127.0.0.1:9222", "ws://127.0.0.1:9222/session"],
		["https://example.test:9222", "wss://example.test:9222/session"],
		// A session-scoped path is passed through untouched rather than rewritten: rewriting it would
		// connect somewhere other than where the caller pointed.
		["ws://127.0.0.1:9222/session/abc-123", "ws://127.0.0.1:9222/session/abc-123"],
	];

	for (const [input, expected] of rows) {
		const actual = normalizeFirefoxEndpoint(input);
		check(`${input} normalizes to ${expected}`, actual === expected, actual);
		check(`${input} normalizes idempotently`, normalizeFirefoxEndpoint(actual) === actual, normalizeFirefoxEndpoint(actual));
	}

	let message = "";
	try {
		normalizeFirefoxEndpoint("127.0.0.1:9222");
	} catch (error) {
		message = (error as Error).message;
	}
	check("an unparseable endpoint is refused", message.includes("ws://host:port/session") && message.includes("http://host:port"), message);
}

console.log("\nfirefox profile preferences");

{
	const { ensureFirefoxPrefs, mergeFirefoxPrefs, renderFirefoxPrefs, PREF_BLOCK_BEGIN } = await import(
		"../src/adapters/firefox-profile.ts"
	);

	const saved = renderFirefoxPrefs({ temporary: false });
	const throwaway = renderFirefoxPrefs({ temporary: true });

	check("the required fission pref is written for both", saved.includes('"fission.webContentIsolationStrategy", 0') && throwaway.includes('"fission.webContentIsolationStrategy", 0'));
	// Firefox turns the password manager off by itself whenever a debugging port is passed. A saved
	// profile exists to stay signed in, so it has to be turned back on; a throwaway one does not.
	check("a saved profile keeps its password manager", saved.includes('"signon.rememberSignons", true'));
	check("a throwaway profile keeps Firefox's hygiene", !throwaway.includes("signon.rememberSignons"));

	const prefLines = saved.split("\n").filter((line) => line.trim() && !line.startsWith("//"));
	check("every written line is a well-formed user_pref", prefLines.every((line) => /^user_pref\("[^"]+", .+\);$/.test(line)), prefLines.join(" | "));

	// The regression guard for the whole reason this file exists. puppeteer's createProfile writes
	// roughly sixty preferences, and a user.js value persists in prefs.js forever — so one launch
	// through puppeteer.launch would permanently damage a profile the user signs in with.
	for (const forbidden of ["dummy.test", "services.settings.server", "network.sntp.pools", "remote.prefs.recommended"]) {
		check(`the managed block never writes ${forbidden}`, !saved.includes(forbidden) && !throwaway.includes(forbidden));
	}

	check("merging into an empty file yields the block", mergeFirefoxPrefs("", saved) === saved);
	check("merging is idempotent", mergeFirefoxPrefs(mergeFirefoxPrefs("", saved), saved) === mergeFirefoxPrefs("", saved));

	const withMine = mergeFirefoxPrefs('user_pref("mine", 1);\n', saved);
	check("a hand-written pref outside the block survives", withMine.includes('user_pref("mine", 1);') && withMine.includes("fission.webContentIsolationStrategy"));

	// A stale block must be replaced, not stacked: a profile relaunched a hundred times would
	// otherwise accumulate a hundred copies.
	const replaced = mergeFirefoxPrefs(withMine, throwaway);
	check("a stale block is replaced rather than duplicated", replaced.split(PREF_BLOCK_BEGIN).length - 1 === 1, String(replaced.split(PREF_BLOCK_BEGIN).length - 1));
	check("the replacement drops the prefs it no longer wants", !replaced.includes("signon.rememberSignons") && replaced.includes('user_pref("mine", 1);'));

	const prefsDir = join(ROOT, "firefox-prefs");
	mkdirSync(prefsDir, { recursive: true });
	ensureFirefoxPrefs(prefsDir, { temporary: false });
	const firstPass = readFileSync(join(prefsDir, "user.js"), "utf8");
	const firstMtime = statSync(join(prefsDir, "user.js")).mtimeMs;
	ensureFirefoxPrefs(prefsDir, { temporary: false });
	check("reprovisioning writes identical content", readFileSync(join(prefsDir, "user.js"), "utf8") === firstPass);
	// profile-store orders the picker by mtime, so rewriting an unchanged file would make every
	// profile look freshly used on every launch.
	check("reprovisioning leaves mtime alone", statSync(join(prefsDir, "user.js")).mtimeMs === firstMtime);
}

console.log("\nfirefox profile liveness");

{
	const { inspectProfile, parseBidiStatus, readBidiEndpoint } = await import("../src/profile-lock.ts");

	check("a ready remote agent is reachable and adoptable", JSON.stringify(parseBidiStatus({ result: { ready: true } })) === JSON.stringify({ reachable: true, sessionAvailable: true }));
	// Firefox permits one WebDriver session per browser process (Bug 1720707). ready:false means the
	// session is taken, not that the browser is unwell — the difference between adopting and erroring.
	check("a taken session is reachable but not adoptable", JSON.stringify(parseBidiStatus({ result: { ready: false, message: "Session already started" } })) === JSON.stringify({ reachable: true, sessionAvailable: false }));
	check("an error reply is not a status", parseBidiStatus({ error: "unknown command", id: 1 }) === undefined);
	check("a non-object payload is not a status", parseBidiStatus("nope") === undefined);

	const liveRoot = join(ROOT, "firefox-live");
	const fxDir = (name: string): string => {
		const path = join(liveRoot, name);
		mkdirSync(path, { recursive: true });
		return path;
	};

	const endpointDir = fxDir("endpoint");
	writeFileSync(join(endpointDir, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 4242 }), "utf8");
	check("the advertised endpoint is read back", readBidiEndpoint(endpointDir)?.url === "ws://127.0.0.1:4242", JSON.stringify(readBidiEndpoint(endpointDir)));
	writeFileSync(join(fxDir("malformed"), "WebDriverBiDiServer.json"), "{not json", "utf8");
	check("a malformed endpoint file is ignored", readBidiEndpoint(join(liveRoot, "malformed")) === undefined);
	check("a missing endpoint file is ignored", readBidiEndpoint(fxDir("no-endpoint")) === undefined);

	// The Firefox counterpart of "an unreachable DevTools port reads as free": port 1 is privileged
	// and nothing answers there, so the file is a leftover from a browser that is gone.
	const deadDir = fxDir("dead-port");
	writeFileSync(join(deadDir, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 1 }), "utf8");
	check("an unreachable BiDi endpoint reads as free", (await inspectProfile(deadDir)).state === "free");

	const staleOwner = fxDir("stale-owner");
	writeFileSync(
		join(staleOwner, ".pi-puppeteer-owner.json"),
		JSON.stringify({ pid: 1, browserURL: "", browserWSEndpoint: "ws://127.0.0.1:1", engine: "firefox", browserKey: "firefox", profile: "work", cwd: staleOwner, startedAt: 0, host: "not-this-host", state: "ready" }),
		"utf8",
	);
	check("a stale Firefox ownership record reads as free", (await inspectProfile(staleOwner)).state === "free");
	check("the stale Firefox record is cleaned up", !existsSync(join(staleOwner, ".pi-puppeteer-owner.json")));

	const startingDir = fxDir("starting");
	writeFileSync(
		join(startingDir, ".pi-puppeteer-owner.json"),
		JSON.stringify({ pid: process.pid, browserURL: "", browserWSEndpoint: "", engine: "firefox", browserKey: "firefox", profile: "work", cwd: startingDir, startedAt: Date.now(), host: hostname(), state: "starting" }),
		"utf8",
	);
	const starting = await inspectProfile(startingDir);
	check("a Firefox claim inside the grace period reads as starting", starting.state === "starting", starting.state);

	// The zero-blast-radius claim, asserted rather than hoped for. A record written before the engine
	// field existed is a Chromium record, and a DevTools port must still be probed over HTTP.
	const legacyDir = fxDir("legacy-chromium");
	writeFileSync(
		join(legacyDir, ".pi-puppeteer-owner.json"),
		JSON.stringify({ pid: process.pid, browserURL: "http://127.0.0.1:1", browserKey: "chrome", profile: "work", cwd: legacyDir, startedAt: 0, host: hostname(), state: "ready" }),
		"utf8",
	);
	check("a record with no engine field still takes the Chromium path", (await inspectProfile(legacyDir)).state === "free");
	const portOnly = fxDir("port-only");
	writeFileSync(join(portOnly, "DevToolsActivePort"), "1\n/devtools/browser/x", "utf8");
	check("a DevToolsActivePort-only profile is unchanged", (await inspectProfile(portOnly)).state === "free");
}

console.log("\nattach endpoints");

{
	const { defaultAttachEndpoint, resolveAttachEndpoint } = await import("../src/config.ts");

	check("the Firefox default is a WebSocket endpoint", defaultAttachEndpoint("firefox") === "ws://127.0.0.1:9222/session", defaultAttachEndpoint("firefox"));
	check("the Chromium default is unchanged", defaultAttachEndpoint("chromium") === "http://127.0.0.1:9222", defaultAttachEndpoint("chromium"));

	const config = loadConfig(project("attach-defaults"));
	check("the built-in firefox entry carries a ws endpoint", config.browsers.firefox?.attach?.browserWSEndpoint === "ws://127.0.0.1:9222/session", JSON.stringify(config.browsers.firefox?.attach));
	check("the built-in chrome entry is untouched", config.browsers.chrome?.attach?.browserURL === "http://127.0.0.1:9222", JSON.stringify(config.browsers.chrome?.attach));

	const firefoxDefinition = config.browsers.firefox;
	if (!firefoxDefinition) throw new Error("the firefox definition is missing");
	check("an explicit endpoint wins", resolveAttachEndpoint(firefoxDefinition, "ws://elsewhere:1/session") === "ws://elsewhere:1/session");
	check("a configured ws endpoint is next", resolveAttachEndpoint(firefoxDefinition) === "ws://127.0.0.1:9222/session");
	check(
		"a configured http endpoint is used when there is no ws one",
		resolveAttachEndpoint({ ...firefoxDefinition, attach: { browserURL: "http://127.0.0.1:1234" } }) === "http://127.0.0.1:1234",
	);
	// The hole this closes: a browser defined in user config with engine "firefox" and no attach block
	// used to fall through to the Chromium URL, which Firefox 152 could never have answered.
	check(
		"a Firefox browser with no attach block falls back per engine",
		resolveAttachEndpoint({ ...firefoxDefinition, attach: undefined }) === "ws://127.0.0.1:9222/session",
		resolveAttachEndpoint({ ...firefoxDefinition, attach: undefined }),
	);
}

console.log("\ntemporary profiles");

{
	const {
		allocateSavedProfile,
		allocateTemporaryProfile,
		ensureProfileMeta,
		nameProfile,
		readProfileMeta,
		resolveProfileByName,
		sweepTemporaryProfiles,
	} = await import("../src/profile-store.ts");

	const root = join(ROOT, "temporary");

	const first = allocateTemporaryProfile(root, "edge");
	const second = allocateTemporaryProfile(root, "edge");
	check("each throwaway launch gets its own directory", first.dir !== second.dir, `${first.dir} / ${second.dir}`);
	check("a throwaway profile is flagged temporary", first.meta.temporary && second.meta.temporary);
	check("a throwaway directory exists on disk", existsSync(first.dir));

	// The claim the whole design rests on: saving is a name change in place, so a running browser is
	// never asked to close, restart, or have its user data dir moved out from under it.
	writeFileSync(join(first.dir, "Cookies"), "SESSION", "utf8");
	const saved = nameProfile(first.dir, "edge", "My Work!");
	check("saving clears the temporary flag", saved.temporary === false);
	check("saving keeps the name verbatim", saved.name === "My Work!", saved.name);
	check("saving does not move the directory", existsSync(join(first.dir, "Cookies")));
	check("the saved flag is persisted", readProfileMeta(first.dir)?.temporary === false);

	const found = resolveProfileByName(root, "edge", "my work!");
	check("a saved profile resolves by name, case-insensitively", found?.dir === first.dir);
	check("a throwaway profile does not resolve by name", resolveProfileByName(root, "edge", second.meta.name) === undefined);

	const listed = await discoverProfiles(root, "edge");
	check("discovery hides throwaway profiles", listed.length === 1 && listed[0]?.profile === "My Work!", JSON.stringify(listed.map((entry) => entry.profile)));
	check("discovery can include them when asked", (await discoverProfiles(root, "edge", { includeTemporary: true })).length === 2);

	// A directory from before the sidecar existed is named by its directory, so that name is adopted
	// rather than the profile being mistaken for junk.
	const legacyDir = join(root, "chrome", "work");
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(legacyDir, "Cookies"), "SESSION", "utf8");
	const upgraded = ensureProfileMeta(legacyDir, "chrome");
	check("a pre-sidecar directory keeps its name", upgraded.name === "work" && upgraded.id === "work");
	check("a pre-sidecar directory is not treated as temporary", !upgraded.temporary);

	// The tmp- prefix is cosmetic. Inferring from it would let the sweep delete a profile someone had
	// named "tmp-scratch" before sidecars existed, taking its signed-in sessions with it.
	const awkward = join(root, "chrome", "tmp-scratch");
	mkdirSync(awkward, { recursive: true });
	writeFileSync(join(awkward, "Cookies"), "SESSION", "utf8");
	check("a pre-sidecar directory named tmp-* is still a saved profile", !ensureProfileMeta(awkward, "chrome").temporary);
	await sweepTemporaryProfiles(root);
	check("and the sweep does not delete it", existsSync(join(awkward, "Cookies")));
	check("upgrading does not move it", existsSync(join(legacyDir, "Cookies")));
	check("upgrading is idempotent", ensureProfileMeta(legacyDir, "chrome").createdAt === upgraded.createdAt);

	// A saved profile's directory stays readable, and a second profile wanting the same one gets a
	// suffix rather than colliding into the first profile's data.
	const alpha = allocateSavedProfile(root, "brave", "Work");
	const beta = allocateSavedProfile(root, "brave", "Work");
	check("a saved profile gets a readable directory", alpha.dir.endsWith(join("brave", "Work")), alpha.dir);
	check("a colliding directory name is suffixed", beta.dir.endsWith(join("brave", "Work-2")), beta.dir);
	check("both keep the name they were given", alpha.meta.name === "Work" && beta.meta.name === "Work");

	// The sweep must be certain rather than merely plausible: it deletes directories.
	const orphan = allocateTemporaryProfile(root, "vivaldi");
	const claimed = allocateTemporaryProfile(root, "vivaldi");
	writeFileSync(
		join(claimed.dir, ".pi-puppeteer-owner.json"),
		JSON.stringify({ pid: process.pid, browserURL: "", browserKey: "vivaldi", profile: claimed.meta.id, cwd: root, startedAt: Date.now(), host: hostname(), state: "starting" }),
		"utf8",
	);
	// A Firefox throwaway whose owner record was lost to a crash. Its endpoint file names a port
	// nothing answers on, so the browser is genuinely gone and the directory is the sweep's to take.
	// The live counterpart of this is a real-browser test: see the Firefox notes in the README.
	const firefoxOrphan = allocateTemporaryProfile(root, "firefox");
	mkdirSync(firefoxOrphan.dir, { recursive: true });
	writeFileSync(join(firefoxOrphan.dir, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 1 }), "utf8");

	await sweepTemporaryProfiles(root);
	check("the sweep removes an abandoned throwaway profile", !existsSync(orphan.dir));
	check("the sweep removes one whose Firefox endpoint is dead", !existsSync(firefoxOrphan.dir));
	check("the sweep leaves one a browser is still starting on", existsSync(claimed.dir));
	check("the sweep never touches a saved profile", existsSync(first.dir) && existsSync(legacyDir) && existsSync(alpha.dir));
}

console.log("\nprofile name entry");

{
	const { controlLines, profileNameState, printableInput, screenFrame } = await import("../src/index.ts");

	const taken = ["default", "work"];
	check("a free name can be confirmed", profileNameState("scratch", "", taken).canConfirm);
	check("a taken name is refused", !profileNameState("work", "", taken).canConfirm);
	check("a taken name is reported as a collision", profileNameState("work", "", taken).collides);
	check("case does not sneak a duplicate past", !profileNameState("WORK", "", taken).canConfirm);
	check("renaming to the current name is allowed", profileNameState("work", "work", taken).canConfirm);
	check("an empty name cannot be confirmed", !profileNameState("   ", "", taken).canConfirm);
	// The directory is named by a separate sanitized ID, so a display name survives punctuation intact.
	check("a name is kept exactly as typed", profileNameState("My Work!", "", taken).name === "My Work!");
	check("a punctuated name can be confirmed", profileNameState("My Work!", "", taken).canConfirm);
	check("surrounding whitespace is trimmed", profileNameState("  work  ", "", taken).name === "work");

	check("typed text is accepted", printableInput("abc") === "abc");
	check("a paste is accepted whole", printableInput("my profile") === "my profile");
	check("Enter is not treated as text", printableInput("\r") === undefined);
	check("Escape sequences are not treated as text", printableInput("\x1b[D") === undefined);
	check("backspace is not treated as text", printableInput("\x7f") === undefined);

	// Control hints wrap only when they would otherwise be truncated. Truncation is not cosmetic here:
	// the hints are ordered by how routine they are, so the first casualty is `Esc back` — the binding
	// a stuck user reaches for.
	{
		const plain = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };
		const hints = [
			"[UD] move", "[Enter] show", "[N] new", "[L] load profile", "[S] save profile",
			"[R] rename", "[D] close", "[B] change default browser", "[Esc] back",
		];
		check("a row that fits stays on one line", controlLines(plain, ["[N] new", "[Esc] back"], 76).length === 1);
		for (const width of [24, 40, 80, 120]) {
			const frame = screenFrame(plain, width);
			// Judge the rendered line, not the packed one. A lone hint can be wider than the frame — at
			// 24 columns "[B] change default browser" is — and the frame truncating that is correct.
			const rendered = frame.clamp(controlLines(plain, hints, frame.innerWidth).map((line) => frame.boxed(line)));
			const widths = [...new Set(rendered.map((line) => [...line].length))];
			check(`controls render at exactly ${width} columns`, widths.length === 1 && widths[0] === width, widths.join("/"));
			check(`controls wrap rather than truncate at ${width}`, width < 40 || rendered.length > 1 || width >= 140, `${rendered.length} line(s)`);
		}
		// Every hint has to survive the wrap; dropping one silently is the bug this replaced.
		const packed = controlLines(plain, hints, 76).join(" ");
		check("no hint is lost when wrapping", hints.every((hint) => packed.includes(hint)), packed);
		check("a narrow frame still yields a line", controlLines(plain, hints, 8).length > 0);
	}

	// A real theme emits ANSI, which the padding helpers do not count; a zero-width stub isolates
	// the geometry.
	const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text, bg: (_color: unknown, text: string) => text };
	for (const width of [24, 40, 80, 120]) {
		const frame = screenFrame(theme, width);
		const lines = frame.clamp([
			frame.border("╭", "─", "╮"),
			frame.boxed(frame.bold("New Profile — Microsoft Edge")),
			frame.boxed(""),
			frame.selectedLine("› work          ● in use by session-1"),
			// The Browser Manager's widest row: name, browser, and the profile column added alongside.
			frame.boxed("  Browser-1       Microsoft Edge  temporary"),
			frame.boxed("[Enter] create  [Esc] cancel"),
			frame.border("╰", "─", "╯"),
		]);
		const rendered = [...new Set(lines.map((line) => [...line].length))];
		check(`every line is exactly ${width} columns`, rendered.length === 1 && rendered[0] === width, rendered.join("/"));
	}
}

console.log("\nansi truncation");

{
	const { truncateAnsi } = await import("../src/index.ts");
	const stripAnsi = (value: string) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
	const coloured = `\x1b[36ma-very-long-session-name\x1b[39m`;

	// A cut mid-run used to drop the run's reset, and the colour then bled through the padding and on
	// into the next column and the border.
	const cut = truncateAnsi(coloured, 10);
	check("a truncated colour is closed", cut.endsWith("\x1b[39m"), JSON.stringify(cut));
	check("a truncated cell still measures its width", stripAnsi(cut).length === 10, `${stripAnsi(cut).length}`);
	// `selectedLine` paints its highlight around the finished line, so a blanket reset inside the
	// content would cancel the row highlight from the cut onwards.
	check("truncation never emits a full reset", !cut.includes("\x1b[0m"), JSON.stringify(cut));

	const bolded = truncateAnsi("\x1b[1m\x1b[38;5;42mbold and coloured\x1b[22m\x1b[39m", 8);
	check("bold is closed too", bolded.includes("\x1b[22m") && bolded.includes("\x1b[39m"), JSON.stringify(bolded));
	// `38;2;r;g;b` carries operands that look like attributes on their own; 49 as a blue value must
	// not be read as "default background".
	const truecolor = truncateAnsi("\x1b[38;2;100;49;22mtruecolor name\x1b[39m", 6);
	check("truecolor operands are not read as attributes", truecolor.endsWith("\x1b[39m"), JSON.stringify(truecolor));
	check("an unstyled cut stays unstyled", truncateAnsi("plain text here", 6) === "plain…", truncateAnsi("plain text here", 6));
	check("a value that fits is returned whole", truncateAnsi(coloured, 80) === coloured);
}

console.log("\nscreen height is a function of the data, not the interaction");

{
	const { browserManagerLines, profilePickerLines, defaultBrowserLines } = await import("../src/index.ts");
	// A real theme emits ANSI, which the padding helpers do not count; a zero-width stub isolates
	// the geometry.
	const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text, bg: (_color: unknown, text: string) => text };
	const WIDTHS = [24, 40, 80, 120];

	const session = (index: number, overrides: Record<string, unknown> = {}) => ({
		id: `session-${index}`,
		name: `Browser-${index}`,
		browserKey: "chrome",
		displayName: "Google Chrome",
		engine: "chromium",
		mode: "launch",
		profile: "work",
		current: index === 1,
		tabCount: 1,
		createdAt: 0,
		lastActiveAt: 0,
		tabs: [],
		...overrides,
	}) as any;

	// Twelve rows so the window scrolls: both overflow markers, one of them, and neither.
	const sessions = [
		session(1, { temporary: true, profile: undefined }),
		session(2, { mode: "attach", profile: undefined }),
		...Array.from({ length: 10 }, (_, index) => session(index + 3)),
	];

	// The interaction states that must not move the frame. A long name forces truncation into the
	// mix, since the column arithmetic runs differently once a cell overflows.
	const named = sessions.map((entry, index) => (index === 4 ? { ...entry, name: "a-browser-with-a-very-long-name" } : entry));
	for (const width of WIDTHS) {
		const heights = new Set<number>();
		for (const list of [sessions, named]) {
			for (let selectedIndex = 0; selectedIndex < list.length; selectedIndex += 1) {
				for (const closeArmed of [false, true]) {
					for (const busy of [undefined, "Closing browser…", "Opening browser…"]) {
						heights.add(browserManagerLines(theme, width, { sessions: list, selectedIndex, closeArmed, busy }).length);
					}
				}
			}
		}
		check(`the manager keeps one height at ${width} columns`, heights.size === 1, [...heights].join("/"));

		const lines = browserManagerLines(theme, width, { sessions, selectedIndex: 3, closeArmed: true });
		const widths = [...new Set(lines.map((line) => [...line].length))];
		check(`the manager renders at exactly ${width} columns`, widths.length === 1 && widths[0] === width, widths.join("/"));
		// The window plus both overflow markers, the title, the blank, the header, the notice, and
		// the borders. Named so a change to the layout has to be deliberate.
		check(`the manager is 6 rows of sessions at ${width}`, lines.length >= 6 + 2, `${lines.length}`);
	}

	// One session on its own: a shorter list is a real data change, but it still must not depend on
	// the interaction either.
	for (const width of WIDTHS) {
		for (const list of [[sessions[0]!], [], sessions.slice(0, 3)]) {
			const heights = new Set<number>();
			for (let selectedIndex = 0; selectedIndex < Math.max(1, list.length); selectedIndex += 1) {
				for (const closeArmed of [false, true]) {
					for (const busy of [undefined, "Closing browser…"]) {
						heights.add(browserManagerLines(theme, width, { sessions: list, selectedIndex, closeArmed, busy }).length);
					}
				}
			}
			check(`a ${list.length}-session manager keeps one height at ${width}`, heights.size === 1, [...heights].join("/"));
		}
	}

	const profile = (index: number, overrides: Record<string, unknown> = {}) => ({
		browserKey: "chrome",
		displayName: "Google Chrome",
		profile: `profile-${index}`,
		inUse: false,
		state: "free",
		sessionId: null,
		ownerCwd: null,
		lastUsedAt: null,
		...overrides,
	}) as any;

	const profiles = [
		profile(1, { inUse: true, state: "live", sessionId: "session-1" }),
		profile(2, { inUse: true, state: "starting" }),
		...Array.from({ length: 10 }, (_, index) => profile(index + 3)),
	];

	for (const width of WIDTHS) {
		const heights = new Set<number>();
		for (let selectedIndex = 0; selectedIndex < profiles.length; selectedIndex += 1) {
			for (const deleteArmed of [false, true]) {
				for (const busy of [undefined, "Deleting profile…", "Looking for profiles…"]) {
					heights.add(profilePickerLines(theme, width, {
						browserLabel: "Google Chrome",
						profiles,
						selectedIndex,
						deleteArmed,
						busy,
						cwd: ROOT,
					}).length);
				}
			}
		}
		check(`the picker keeps one height at ${width} columns`, heights.size === 1, [...heights].join("/"));

		const lines = profilePickerLines(theme, width, {
			browserLabel: "Google Chrome",
			profiles,
			selectedIndex: 0,
			deleteArmed: true,
			cwd: ROOT,
		});
		const widths = [...new Set(lines.map((line) => [...line].length))];
		check(`the picker renders at exactly ${width} columns`, widths.length === 1 && widths[0] === width, widths.join("/"));
	}

	// The two screens share a structure, not a line count: an empty manager offers four controls where
	// an empty picker offers two, so they legitimately wrap differently on a narrow terminal. What has
	// to match is that both reserve a notice row rather than pushing one only when it has something to
	// say — the drift that made the manager grow a line when a close was armed.
	for (const width of WIDTHS) {
		const quiet = profilePickerLines(theme, width, { browserLabel: "Google Chrome", profiles, selectedIndex: 2, deleteArmed: false, cwd: ROOT });
		const noisy = profilePickerLines(theme, width, { browserLabel: "Google Chrome", profiles, selectedIndex: 0, deleteArmed: true, cwd: ROOT });
		check(`the picker reserves its notice row at ${width}`, quiet.length === noisy.length, `${quiet.length}/${noisy.length}`);

		const unarmed = browserManagerLines(theme, width, { sessions, selectedIndex: 0, closeArmed: false });
		const armed = browserManagerLines(theme, width, { sessions, selectedIndex: 0, closeArmed: true });
		check(`the manager reserves its notice row at ${width}`, unarmed.length === armed.length, `${unarmed.length}/${armed.length}`);
	}

	const browsers = [
		{ key: "system", label: "System [chrome] — OS default" },
		{ key: "chrome", label: "Google Chrome" },
		{ key: "edge", label: "Microsoft Edge" },
	];
	for (const width of WIDTHS) {
		const heights = new Set<number>();
		for (let selectedIndex = 0; selectedIndex < browsers.length; selectedIndex += 1) {
			const lines = defaultBrowserLines(theme, width, { options: browsers, selectedIndex });
			heights.add(lines.length);
			const widths = [...new Set(lines.map((line) => [...line].length))];
			check(`the browser picker renders row ${selectedIndex} at exactly ${width} columns`, widths.length === 1 && widths[0] === width, widths.join("/"));
		}
		check(`the browser picker keeps one height at ${width} columns`, heights.size === 1, [...heights].join("/"));
	}
}

console.log("\nemulation on browsers without the emulation.* commands");
{
	const { ProtocolError } = await import("puppeteer-core");
	const { emulationSkipNote, unknownEmulationCommand, unknownProtocolCommand } = await import("../src/emulation.ts");

	// Firefox's own phrasing, stack trace and all — the thing the matcher has to survive.
	const orientation = new ProtocolError(
		"Protocol error (emulation.setScreenOrientationOverride): unknown command emulation.setScreenOrientationOverride " +
			"RemoteError@chrome://remote/content/shared/RemoteError.sys.mjs:8:8",
	);
	const userAgent = new ProtocolError("Protocol error (emulation.setUserAgentOverride): unknown command emulation.setUserAgentOverride");
	const other = new ProtocolError("Protocol error (script.evaluate): unknown command script.evaluate");

	check("an unknown emulation command is recognised", unknownEmulationCommand(orientation) === "emulation.setScreenOrientationOverride", String(unknownEmulationCommand(orientation)));
	check("so is the user agent one", unknownEmulationCommand(userAgent) === "emulation.setUserAgentOverride", String(unknownEmulationCommand(userAgent)));
	check("a non-emulation command is not claimed by the workaround", unknownEmulationCommand(other) === undefined, String(unknownEmulationCommand(other)));
	check("but it is still recognised as a missing command", unknownProtocolCommand(other) === "script.evaluate", String(unknownProtocolCommand(other)));

	// A real bug must keep its own error rather than be mistaken for an old browser.
	check("an unrelated protocol error is left alone", unknownProtocolCommand(new ProtocolError("Protocol error (browsingContext.navigate): timeout")) === undefined);
	check("a plain Error is left alone", unknownProtocolCommand(new Error("unknown command emulation.setUserAgentOverride")) === undefined);

	check("nothing skipped means no note", emulationSkipNote([]) === "");
	const orientationNote = emulationSkipNote(["screen orientation"]);
	check("the note names the version that fixes it", orientationNote.includes("Firefox 144 or newer"), orientationNote);
	check("the note confirms the size still applied", orientationNote.includes("viewport size was applied"), orientationNote);
	const bothNote = emulationSkipNote(["screen orientation", "user agent"]);
	check("a mixed note quotes the higher version", bothNote.includes("Firefox 145 or newer"), bothNote);
	check("a mixed note reads as a list", bothNote.includes("screen orientation and user agent"), bothNote);
	check("a user-agent-only note does not mention the touch cutoff", !emulationSkipNote(["user agent"]).includes("144"), emulationSkipNote(["user agent"]));
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
