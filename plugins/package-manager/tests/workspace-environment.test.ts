import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const workspaceVariables = [
	'PNPM_CONFIG_WORKSPACE_DIR',
	'pnpm_config_workspace_dir',
	'NPM_CONFIG_WORKSPACE_DIR',
	'npm_config_workspace_dir',
] as const
const emptyWorkspaceEnvironment = Object.fromEntries(workspaceVariables.map((name) => [name, '']))
const source = new URL('../src/pnpm-engine.ts', import.meta.url).href
const tsx = createRequire(import.meta.url).resolve('tsx')

it.each([
	...workspaceVariables.map((name) => ({ name, conflict: name })),
	{ name: 'empty first value falls through', conflict: 'pnpm_config_workspace_dir' },
	{ name: 'matching directory is accepted', conflict: null },
	{ name: 'first non-empty value owns precedence', conflict: null, lowerPriorityConflict: true },
])(
	'keeps native installation within its explicit root: $name',
	async (scenario) => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-pnpm-environment-'))
		const directory = resolve(root, 'installation')
		const neighbor = resolve(root, 'neighbor')
		const inherited = Object.fromEntries(
			workspaceVariables.map((name) => [name, process.env[name]]),
		)
		try {
			await mkdir(directory)
			await mkdir(resolve(neighbor, 'node_modules'), { recursive: true })
			await writeFile(
				resolve(neighbor, 'package.json'),
				'{"name":"untouched-neighbor","private":true}\n',
			)
			await writeFile(resolve(neighbor, 'pnpm-workspace.yaml'), 'packages: []\n')
			await writeFile(resolve(neighbor, 'node_modules/sentinel'), 'untouched\n')
			const environment = {
				...process.env,
				...emptyWorkspaceEnvironment,
				...(scenario.conflict
					? { [scenario.conflict]: neighbor }
					: { PNPM_CONFIG_WORKSPACE_DIR: resolve(directory, '.') }),
				...('lowerPriorityConflict' in scenario ? { npm_config_workspace_dir: neighbor } : {}),
			}
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					'--import',
					tsx,
					'--input-type=module',
					'--eval',
					`import { loadPnpmEngine } from ${JSON.stringify(source)};
const engine = await loadPnpmEngine();
const dir = ${JSON.stringify(directory)};
const results = {};
for (const action of ['readConfig', 'install']) {
  try {
    if (action === 'readConfig') engine.readConfig({ dir });
    else await engine.install({ dir, projects: [{ rootDir: dir, manifest: { name: 'private-installation', private: true } }], storeDir: ${JSON.stringify(resolve(root, 'store'))}, cacheDir: ${JSON.stringify(resolve(root, 'cache'))}, ignoreScripts: true });
    results[action] = 'accepted';
  } catch (error) { results[action] = error.message; }
}
console.log(JSON.stringify(results));`,
				],
				{ env: environment, timeout: 20_000 },
			)
			const result = JSON.parse(stdout) as Record<string, string>
			const expected = scenario.conflict
				? `${scenario.conflict}=${neighbor}: it differs from the explicit installation directory ${directory}.`
				: 'accepted'
			expect(result).toEqual({
				readConfig: expect.stringContaining(expected),
				install: expect.stringContaining(expected),
			})
			expect(await readFile(resolve(neighbor, 'node_modules/sentinel'), 'utf8')).toBe('untouched\n')
			expect(await readFile(resolve(neighbor, 'package.json'), 'utf8')).toBe(
				'{"name":"untouched-neighbor","private":true}\n',
			)
			const neighborFiles = await readdir(neighbor)
			expect(neighborFiles.sort()).toEqual(['node_modules', 'package.json', 'pnpm-workspace.yaml'])
			expect(
				Object.fromEntries(workspaceVariables.map((name) => [name, process.env[name]])),
			).toEqual(inherited)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
	25_000,
)
