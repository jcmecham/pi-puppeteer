import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../src/config.ts";
import type { RawExtensionConfig } from "../src/types.ts";

// Interactive (or scripted) picker for the default browser. Lists every browser the
// extension knows about, shows which ones were actually discovered on this machine,
// and writes the chosen key to the project config at .pi/.pi-puppeteer/settings.json.
//
//   npx tsx scripts/configure.ts          # interactive menu
//   npx tsx scripts/configure.ts edge     # set non-interactively

const cwd = process.cwd();
const config = loadConfig(cwd);
const projectConfigPath = config.configPaths.project;

const browserEntries = Object.entries(config.browsers).map(([key, def]) => ({
	key,
	displayName: def.displayName,
	engine: def.engine,
	executablePath: def.executablePath,
	hasAttach: Boolean(def.attach),
}));

const entries = [
	{
		key: "system",
		displayName: "System",
		engine: "pi-puppeteer",
		executablePath: undefined,
		hasAttach: false,
	},
	...browserEntries,
];

function describe(entry: (typeof entries)[number]): string {
	if (entry.key === "system") {
		const current = config.defaultBrowserSetting === "system" ? " (current default)" : "";
		return `System [${config.systemDefaultBrowser}] — OS default${current}`;
	}

	const status = entry.executablePath
		? `found: ${entry.executablePath}`
		: entry.hasAttach
			? "attach only"
			: "not found";
	const current = entry.key === config.defaultBrowserSetting ? " (current default)" : "";
	return `${entry.displayName} [${entry.key}] — ${entry.engine}, ${status}${current}`;
}

async function writeDefault(key: string): Promise<void> {
	const existing: RawExtensionConfig = existsSync(projectConfigPath)
		? (JSON.parse(readFileSync(projectConfigPath, "utf8")) as RawExtensionConfig)
		: {};
	existing.defaultBrowser = key;
	await mkdir(dirname(projectConfigPath), { recursive: true });
	await writeFile(projectConfigPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

function print(line: string): void {
	process.stdout.write(`${line}\n`);
}

print("Browsers known to pi-puppeteer:\n");
entries.forEach((entry, index) => print(`  ${index + 1}. ${describe(entry)}`));
print("");

const argKey = process.argv[2];

async function resolveSelection(): Promise<string | undefined> {
	if (argKey) {
		if (argKey !== "system" && !config.browsers[argKey]) {
			print(`Unknown browser key: ${argKey}`);
			return undefined;
		}
		return argKey;
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`Select default browser [1-${entries.length}, or key]: `)).trim();
		if (!answer) return undefined;
		const asNumber = Number(answer);
		if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= entries.length) {
			return entries[asNumber - 1]!.key;
		}
		if (config.browsers[answer]) return answer;
		print(`Unrecognized selection: ${answer}`);
		return undefined;
	} finally {
		rl.close();
	}
}

const selected = await resolveSelection();
if (!selected) {
	print("No changes made.");
	process.exit(argKey ? 1 : 0);
}

await writeDefault(selected);
const resolved = selected === "system" ? ` (resolves to '${config.systemDefaultBrowser}')` : "";
print(`\nDefault browser set to '${selected}'${resolved}.`);
print(`Wrote ${join(".pi", ".pi-puppeteer", "settings.json")} (defaultBrowser: "${selected}").`);
if (selected !== "system" && !config.browsers[selected]?.executablePath && !config.browsers[selected]?.attach) {
	print(`Note: '${selected}' was not discovered on this machine — set its executablePath or attach endpoint in the config.`);
}
