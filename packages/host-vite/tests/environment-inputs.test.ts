import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { checkProjectScript } from '@pluxel/rolldown/scripts'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import {
	collectHostEvaluatedInputs,
	hostEnvironment,
	HOST_VITE_ENVIRONMENT,
	importHostModule,
} from '../src/environment'
import { hostSingletons } from '../src/singletons'

it('reads the original inputs from the actual cached ModuleRunner source maps', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'pluxel-evaluated-inputs-'))
	const dependency = resolve(directory, 'dependency.ts')
	const entry = resolve(directory, 'entry.ts')
	const original = 'export const value: number = 1\n'
	await writeFile(dependency, original)
	await writeFile(entry, "export { value } from './dependency'\n")
	const server = await createServer({
		root: directory,
		configFile: false,
		plugins: [hostEnvironment()],
		server: { watch: null },
		logLevel: 'silent',
	})
	try {
		expect(await importHostModule(server, entry)).toMatchObject({ value: 1 })
		await writeFile(dependency, 'export const value: number = 2\n')
		expect(await importHostModule(server, entry)).toMatchObject({ value: 1 })
		const inputs = collectHostEvaluatedInputs(server, entry)
		expect(inputs.get(dependency)).toBe(original)
		expect(inputs.get(entry)).toBe("export { value } from './dependency'\n")
	} finally {
		await server.close()
		await rm(directory, { recursive: true, force: true })
	}
})

it('checks console scripts with their Host configuration and rejects browser declaration inputs for lowered source', async () => {
	const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'pluxel-project-inputs-')))
	const web = resolve(directory, 'host/web')
	const plugin = resolve(directory, 'plugins/audit')
	const source = resolve(plugin, 'src/index.ts')
	const browserEntry = resolve(web, 'probe.ts')
	const consoleEntry = resolve(web, 'dev/probe.ts')
	const original = `import {BasePlugin,Plugin} from '@pluxel/core'
@Plugin()
export class AuditPlugin extends BasePlugin {
  private readonly history: string[] = []
  record(message: string): void { this.history.push(message) }
}
`
	await Promise.all(
		['host/web/dev', 'plugins/audit/src', 'plugins/audit/dist', 'node_modules/@example'].map(
			(path) => mkdir(resolve(directory, path), { recursive: true }),
		),
	)
	for (const [name, from] of [
		['@pluxel/core', '../node_modules/@pluxel/core'],
		['@types/node', '../../../node_modules/@types/node'],
	]) {
		const target = resolve(directory, 'node_modules', name)
		await mkdir(dirname(target), { recursive: true })
		await symlink(await realpath(resolve(import.meta.dirname, from)), target, 'dir')
	}
	await symlink(plugin, resolve(directory, 'node_modules/@example/audit-plugin'), 'dir')
	await Promise.all([
		writeFile(
			resolve(directory, 'host/tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2024',
					module: 'ESNext',
					moduleResolution: 'bundler',
					lib: ['ES2024'],
					types: ['node'],
					typeRoots: [resolve(directory, 'node_modules/@types')],
					customConditions: ['@pluxel/hmr'],
					experimentalDecorators: true,
					strict: true,
					skipLibCheck: true,
					noEmit: true,
				},
			}),
		),
		writeFile(
			resolve(web, 'tsconfig.json'),
			JSON.stringify({
				extends: '../tsconfig.json',
				compilerOptions: { customConditions: [], experimentalDecorators: false, types: [] },
			}),
		),
		writeFile(
			resolve(web, 'dev/tsconfig.json'),
			JSON.stringify({ extends: '../../tsconfig.json', include: ['**/*.ts'] }),
		),
		writeFile(
			resolve(plugin, 'package.json'),
			JSON.stringify({
				name: '@example/audit-plugin',
				type: 'module',
				exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' } },
			}),
		),
		writeFile(source, original),
		writeFile(resolve(plugin, 'dist/index.mjs'), 'export class AuditPlugin {}\n'),
		writeFile(
			resolve(plugin, 'dist/index.d.mts'),
			"import {BasePlugin} from '@pluxel/core'; export declare class AuditPlugin extends BasePlugin {record(message:string):void}\n",
		),
		writeFile(browserEntry, "export {AuditPlugin} from '@example/audit-plugin'\n"),
		writeFile(consoleEntry, "export {AuditPlugin} from '@example/audit-plugin'\n"),
	])
	const pipeline = createPluginSourceVitePipeline({
		root: web,
		environment: HOST_VITE_ENVIRONMENT,
		lintGuard: false,
	})
	const server = await createServer({
		root: web,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true, watch: null },
		plugins: [hostEnvironment(), hostSingletons(), ...pipeline.plugins],
	})
	try {
		const browserChecked = await checkProjectScript({ file: browserEntry })
		const browserExports = await importHostModule(server, browserEntry)
		const browserInputs = collectHostEvaluatedInputs(server, browserEntry)
		expect(browserInputs.get(source)).toBe(original)
		expect(browserChecked.inputs.get(source)).toBeUndefined()
		expect(browserChecked.inputs.has(resolve(plugin, 'dist/index.d.mts'))).toBe(true)
		// The unchanged source guard rejects this real checker/runtime resolution mismatch.
		expect(
			[...browserInputs].filter(([path, content]) => browserChecked.inputs.get(path) !== content),
		).toEqual([[source, original]])
		const consoleChecked = await checkProjectScript({ file: consoleEntry })
		const consoleExports = await importHostModule(server, consoleEntry)
		expect(consoleExports.AuditPlugin).toBe(browserExports.AuditPlugin)
		expect(consoleChecked.inputs.get(source)).toBe(original)
		for (const [path, content] of collectHostEvaluatedInputs(server, consoleEntry))
			expect(consoleChecked.inputs.get(path)).toBe(content)
	} finally {
		await server.close()
		await rm(directory, { recursive: true, force: true })
	}
})
