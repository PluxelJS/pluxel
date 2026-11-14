import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { rolldown } from 'rolldown'
import { build as pack, type TsdownPlugin } from 'vite-plus/pack'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import { generatePluginControl } from '../src/control/generate'
import { createPluginControlPlugin } from '../src/control/plugin'
import { verifyPluginControlMaterial } from '../src/control/manifest'
import { createPluginSemanticsPlugin } from '../src/rolldown/plugins/pluginSemanticsPlugin'
import { configSourcePlugin } from '../src/rolldown/plugins/configSourcePlugin'

const run = promisify(execFile)
const fixtures: string[] = []
const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

afterEach(async () => {
	await Promise.all(
		fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

async function fixture() {
	const directory = await mkdtemp(resolve(tmpdir(), 'pluxel-control-fixture-'))
	fixtures.push(directory)
	for (const name of ['@pluxel/core', '@pluxel/host', '@types/node', 'valibot']) {
		const dependency = resolve(directory, 'node_modules', name)
		await mkdir(dirname(dependency), { recursive: true })
		await symlink(resolve(root, 'node_modules', name), dependency, 'dir')
	}
	await writeFile(
		resolve(directory, 'tsconfig.json'),
		JSON.stringify({
			extends: resolve(root, 'tsconfig.json'),
			compilerOptions: { strictNullChecks: true, experimentalDecorators: true },
			include: ['*.ts'],
		}),
	)
	await writeFile(
		resolve(directory, 'payload.ts'),
		'export interface Payload { readonly id: string }\n',
	)
	await writeFile(
		resolve(directory, 'ambient.d.ts'),
		'/// <reference path="./detail.d.ts" />\ndeclare global { interface ControlAmbient extends ControlAmbientDetail { label:string } }\nexport {}\n',
	)
	await writeFile(
		resolve(directory, 'detail.d.ts'),
		'declare global { interface ControlAmbientDetail { rank:number } }\nexport {}\n',
	)
	await writeFile(
		resolve(directory, 'part.ts'),
		`import { PluginPart } from '@pluxel/core'
import * as v from 'valibot'
import type { Counter } from './counter.ts'
export class CounterPart extends PluginPart<Counter> {
 private readonly config = this.configs.use(v.object({enabled:v.optional(v.boolean(),true)}))
 owner(): Counter { return this.host }
 enabled(): boolean { return this.config.enabled }
}`,
	)
	await writeFile(
		resolve(directory, 'counter.ts'),
		`import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { CounterPart } from './part.ts'
import type { Payload } from './payload.ts'
throw new Error('control generation must never evaluate implementation')
/** The default is declared here, including an escaped terminator in a string. */
const DEFAULT_COUNT = 2
const CounterConfig = v.object({count:v.optional(v.pipe(v.number(),v.minValue(0)),DEFAULT_COUNT),note:v.optional(v.string(),'*/')})
export abstract class BusinessBase extends BasePlugin { inherited<T>(value:T):T { return value } }
export class NativeHandle { #brand=0; read():number {return this.#brand} }
@Plugin(BusinessBase)
export class Counter extends BusinessBase {
 private brand = 0
 private readonly config = this.configs.use(CounterConfig)
 readonly part = this.parts.use(CounterPart)
 same(other:Counter):Counter { this.brand++; return other }
 handle():NativeHandle {return new NativeHandle()}
 self():this { return this }
 payload(value:Payload):Payload { return value }
	 /** Example: import("./documentation-only.js") does not resolve or execute. */
	 ambient(value:ControlAmbient):ControlAmbient { return value }
 overload(value:number):number
 overload(value:string):string
 overload(value:number|string):number|string { return value }
 generic<T extends {id:string}>(value:T):T { return value }
}
`,
	)
	return directory
}

const definition = {
	entry: { kind: 'source-entry' as const, sourceSpace: 'app', path: 'counter.ts' },
	exportName: 'Counter',
}

async function externalTypesFixture() {
	const directory = await fixture()
	const external = resolve(directory, 'node_modules/control-test-sdk')
	await mkdir(external, { recursive: true })
	await writeFile(
		resolve(external, 'package.json'),
		JSON.stringify({ name: 'control-test-sdk', types: 'index.d.ts' }),
	)
	const counter = resolve(directory, 'counter.ts')
	const source = await readFile(counter, 'utf8')
	await writeFile(
		counter,
		"import type {OptionalSdk} from 'control-test-sdk'\n" +
			source.replace(
				'self():this',
				'optional(value:OptionalSdk):OptionalSdk{return value} self():this',
			),
	)
	return {
		directory,
		declaration: resolve(external, 'index.d.ts'),
		generate: () =>
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: counter, className: 'Counter', definition }],
			}),
	}
}

describe('Plugin control compiler', () => {
	it('uses the build root compiler environment independently of sorted source ownership', async () => {
		const directory = await fixture()
		await writeFile(
			resolve(directory, 'root.d.ts'),
			'declare global { interface BuildRootAmbient { root: true } } export {}',
		)
		const foreign = resolve(directory, '000-foreign')
		await mkdir(foreign)
		await writeFile(
			resolve(foreign, 'tsconfig.json'),
			JSON.stringify({ compilerOptions: { types: ['missing-foreign-environment'] } }),
		)
		await writeFile(
			resolve(foreign, 'foreign.ts'),
			`import {BasePlugin, Plugin} from '@pluxel/core'
@Plugin()
export class Foreign extends BasePlugin { value(input:BuildRootAmbient):BuildRootAmbient{return input} }`,
		)
		const generation = await generatePluginControl({
			root: directory,
			definitions: [
				{ moduleId: resolve(directory, 'counter.ts'), className: 'Counter', definition },
				{
					moduleId: resolve(foreign, 'foreign.ts'),
					className: 'Foreign',
					definition: {
						entry: { kind: 'source-entry', sourceSpace: 'app', path: '000-foreign/foreign.ts' },
						exportName: 'Foreign',
					},
				},
			],
		})
		expect(generation.manifest.definitions).toHaveLength(2)
		expect(Object.keys(generation.inputs)).toContain(resolve(directory, 'tsconfig.json'))
		expect(Object.keys(generation.inputs)).not.toContain(resolve(foreign, 'tsconfig.json'))
	}, 30_000)

	it('follows actual tsdown custom-project and no-project selections', async () => {
		const directory = await fixture()
		const entry = resolve(directory, 'plain.ts')
		await writeFile(
			entry,
			`import {BasePlugin, Plugin} from '@pluxel/core'
@Plugin()
export class Plain extends BasePlugin { readonly value = 1n }`,
		)
		const configured = JSON.parse(await readFile(resolve(directory, 'tsconfig.json'), 'utf8'))
		await writeFile(
			resolve(directory, 'control.build.json'),
			JSON.stringify({
				...configured,
				compilerOptions: { ...configured.compilerOptions, types: ['node'] },
			}),
		)
		configured.compilerOptions.types = ['missing-root-environment']
		await writeFile(resolve(directory, 'tsconfig.json'), JSON.stringify(configured))
		for (const tsconfig of ['control.build.json', false] as const) {
			const semantics = createPluginSemanticsPlugin({ root: directory })
			const semanticPlugin = semantics.plugin as TsdownPlugin
			let inputs: readonly string[] = []
			await pack({
				config: false,
				cwd: directory,
				entry,
				tsconfig,
				outDir: tsconfig === false ? 'without-project' : 'custom-project',
				dts: false,
				report: false,
				logLevel: 'silent',
				external: ['@pluxel/core'],
				plugins: [
					semanticPlugin,
					createPluginControlPlugin({
						root: directory,
						semantics,
						onGenerated: (generation) => {
							inputs = Object.keys(generation.inputs)
						},
					}),
				],
			})
			expect(inputs).not.toContain(resolve(directory, 'tsconfig.json'))
			expect(inputs.includes(resolve(directory, 'control.build.json'))).toBe(tsconfig !== false)
			const manifest = JSON.parse(
				await readFile(
					resolve(
						directory,
						tsconfig === false ? 'without-project' : 'custom-project',
						'control/manifest.json',
					),
					'utf8',
				),
			)
			expect(manifest.definitions).toHaveLength(1)
		}
	}, 30_000)

	it('preserves the author Node-only libraries and target constraints', async () => {
		const directory = await fixture()
		const config = resolve(directory, 'tsconfig.json')
		const configured = JSON.parse(await readFile(config, 'utf8'))
		configured.compilerOptions.lib = ['ES2024']
		configured.compilerOptions.target = 'ES2024'
		configured.compilerOptions.customConditions = ['@pluxel/hmr']
		const original = JSON.stringify(configured)
		await writeFile(config, original)
		const counter = resolve(directory, 'counter.ts')
		const counterSource = await readFile(counter, 'utf8')
		const source =
			"import {Readable} from 'node:stream'\n" +
			counterSource.replace(
				'self():this',
				'stream(value:Readable):ReadableStream<Uint8Array>{return Readable.toWeb(value) as ReadableStream<Uint8Array>} self():this',
			)
		await writeFile(counter, source)
		const generate = () =>
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: counter, className: 'Counter', definition }],
			})
		const generation = await generate()
		expect(
			Object.keys(generation.inputs).some((path) => /\/lib\.dom(?:\.iterable)?\.d\.ts$/.test(path)),
		).toBe(false)
		expect(await readFile(config, 'utf8')).toBe(original)
		configured.compilerOptions.target = 'ES2017'
		const limited = JSON.stringify(configured)
		await writeFile(config, limited)
		await writeFile(
			counter,
			source.replace('self():this', 'named():RegExp{return /(?<name>x)/} self():this'),
		)
		await expect(generate()).rejects.toThrow(
			/Named capturing groups are only available when targeting 'ES2018' or later/,
		)
		expect(await readFile(config, 'utf8')).toBe(limited)
	}, 30_000)

	it('retains upstream suppressed optional external types and hashes their actual resolution', async () => {
		const { directory, declaration, generate } = await externalTypesFixture()
		const body =
			"type OptionalElectron = typeof import('control-test-electron');\nexport interface OptionalSdk { readonly electron:OptionalElectron }\n"
		const ignored = '// @ts-ignore this is any when the optional SDK is absent\n' + body
		await writeFile(declaration, ignored)
		const absent = await generate()
		expect(await readFile(declaration, 'utf8')).toBe(ignored)
		expect(absent.definitionInputs[pluginDefinitionIndexKey(definition)]).toContain(declaration)
		expect(
			Object.keys(absent.inputs).some((path) => path.includes('/control-test-electron/')),
		).toBe(false)
		await writeFile(
			resolve(directory, 'optional-usage.ts'),
			"import type {OptionalSdk} from 'control-test-sdk'; declare const sdk:OptionalSdk; const value:string=sdk.electron.originalAnyContract; void value\n",
		)
		await writeFile(
			resolve(directory, 'optional-tsconfig.json'),
			JSON.stringify({
				extends: resolve(root, 'tsconfig.json'),
				compilerOptions: { strictNullChecks: true, skipLibCheck: false },
				files: ['optional-usage.ts'],
				include: [],
			}),
		)
		const checkOriginal = () =>
			run(
				process.execPath,
				[
					resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
					'--project',
					resolve(directory, 'optional-tsconfig.json'),
					'--pretty',
					'false',
				],
				{ maxBuffer: 1024 * 1024 },
			)
		await checkOriginal()
		await writeFile(
			declaration,
			'// @ts-expect-error optional dependency\n\n// retained comment\n' + body,
		)
		await expect(generate()).resolves.toHaveProperty('format', 1)
		await checkOriginal()
		await writeFile(declaration, ignored)
		const installed = resolve(directory, 'node_modules/control-test-electron')
		await mkdir(installed)
		await writeFile(
			resolve(installed, 'package.json'),
			JSON.stringify({ name: 'control-test-electron', types: 'index.d.ts' }),
		)
		const installedTypes = resolve(installed, 'index.d.ts')
		await writeFile(installedTypes, 'export declare function launch():Promise<void>\n')
		const present = await generate()
		expect(present.definitionInputs[pluginDefinitionIndexKey(definition)]).toContain(installedTypes)
		expect(present.manifest.definitions[0]!.contracts.instance).not.toBe(
			absent.manifest.definitions[0]!.contracts.instance,
		)
		expect(present.manifest.definitions[0]!.contracts.config).toBe(
			absent.manifest.definitions[0]!.contracts.config,
		)
	}, 30_000)

	it('accepts native ambient module declarations and rejects the same bare import without its provider', async () => {
		const { directory, declaration, generate } = await externalTypesFixture()
		const provider = resolve(directory, 'native-module.d.ts')
		await writeFile(
			provider,
			'declare module "control-test-native-module" { export interface NativeHandle { readonly id: string } }',
		)
		await writeFile(
			declaration,
			'import type {NativeHandle} from "control-test-native-module"; export interface OptionalSdk { readonly handle: NativeHandle }',
		)
		const generation = await generate()
		expect(Object.keys(generation.inputs)).toContain(provider)
		expect(generation.manifest.definitions).toHaveLength(1)
		await rm(provider)
		await expect(generate()).rejects.toThrow(
			/Cannot resolve emitted declaration import "control-test-native-module"/,
		)
	}, 30_000)

	it('rejects missing external types without a directive on their actual diagnostic line', async () => {
		const { directory, declaration, generate } = await externalTypesFixture()
		const config = resolve(directory, 'optional-tsconfig.json')
		await writeFile(
			config,
			JSON.stringify({
				extends: resolve(root, 'tsconfig.json'),
				compilerOptions: { skipLibCheck: false },
				files: [declaration],
				include: [],
			}),
		)
		const body =
			"type OptionalElectron = typeof import('control-test-electron');\nexport interface OptionalSdk { readonly electron:OptionalElectron }\n"
		for (const source of [
			body,
			'export type Example = "// @ts-ignore";\n' + body,
			'// @ts-ignore\nexport declare const unrelated:unknown;\n' + body,
			'// @ts-ignore\n' + body.replace(' = typeof', ' =\n typeof'),
		]) {
			await writeFile(declaration, source)
			await expect(generate()).rejects.toThrow(
				/Cannot resolve emitted declaration import.*control-test-electron/,
			)
			await expect(
				run(
					process.execPath,
					[
						resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
						'--project',
						config,
						'--pretty',
						'false',
					],
					{ maxBuffer: 1024 * 1024 },
				),
			).rejects.toMatchObject({ stdout: expect.stringContaining('TS2307:') })
		}
	}, 30_000)

	it('resolves author type directives from the project and reports missing inputs without rewriting them', async () => {
		const directory = await fixture()
		const config = resolve(directory, 'tsconfig.json')
		const configured = JSON.parse(await readFile(config, 'utf8'))
		const environment = resolve(directory, 'node_modules/control-test-environment')
		const environmentTypes = resolve(environment, 'types/client.d.ts')
		await mkdir(dirname(environmentTypes), { recursive: true })
		await writeFile(
			resolve(environment, 'package.json'),
			JSON.stringify({
				name: 'control-test-environment',
				exports: { './client': { types: './types/client.d.ts' } },
			}),
		)
		await writeFile(
			environmentTypes,
			'declare global { interface ControlConfiguredEnvironment { label:string } } export {}\n',
		)
		const nodeProvider = resolve(directory, 'node-environment.ts')
		await writeFile(
			nodeProvider,
			'/// <reference types="node" preserve="true" />\nexport function observe(value:object):void{void value}\n',
		)
		configured.compilerOptions.types = ['control-test-environment/client']
		const original = JSON.stringify(configured)
		await writeFile(config, original)
		const counter = resolve(directory, 'counter.ts')
		const source = await readFile(counter, 'utf8')
		await writeFile(
			counter,
			"import {observe} from './node-environment.ts'\n" +
				source
					.replace('this.brand++; return other', 'observe(this); this.brand++; return other')
					.replace(
						'self():this',
						'environment(value:ControlConfiguredEnvironment):ControlConfiguredEnvironment{return value} self():this',
					),
		)
		const generate = () =>
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: counter, className: 'Counter', definition }],
			})
		const generation = await generate()
		expect(Object.keys(generation.inputs)).toContain(environmentTypes)
		expect(Object.keys(generation.inputs)).toContain(nodeProvider)
		expect(await readFile(config, 'utf8')).toBe(original)
		configured.compilerOptions.types = ['control-test-missing-types']
		const missing = JSON.stringify(configured)
		await writeFile(config, missing)
		await expect(generate()).rejects.toThrow(
			"Cannot find type definition file for 'control-test-missing-types'",
		)
		expect(await readFile(config, 'utf8')).toBe(missing)
	}, 30_000)

	it('retains ambient types admitted through an implementation-only import after native declaration emit', async () => {
		const directory = await fixture()
		const config = resolve(directory, 'tsconfig.json')
		const configured = JSON.parse(await readFile(config, 'utf8'))
		configured.compilerOptions.types = []
		configured.compilerOptions.customConditions = ['@pluxel/hmr']
		const original = JSON.stringify(configured)
		await writeFile(config, original)
		const loader = resolve(directory, 'node_modules/control-test-ambient-loader')
		await mkdir(loader, { recursive: true })
		await writeFile(
			resolve(loader, 'package.json'),
			JSON.stringify({ name: 'control-test-ambient-loader', types: 'index.d.ts' }),
		)
		await writeFile(
			resolve(loader, 'index.d.ts'),
			'/// <reference types="node" />\nexport declare function observe(value:object):void\n',
		)
		const counter = resolve(directory, 'counter.ts')
		const source = await readFile(counter, 'utf8')
		await writeFile(
			counter,
			"import {observe} from 'control-test-ambient-loader'\n" +
				source.replace('this.brand++; return other', 'observe(this); this.brand++; return other'),
		)
		const generation = await generatePluginControl({
			root: directory,
			definitions: [{ moduleId: counter, className: 'Counter', definition }],
		})
		expect(generation.manifest.definitions[0]!.contracts.instance).toMatch(/^sha256:/)
		expect(generation.definitionInputs[pluginDefinitionIndexKey(definition)]).toContain(
			resolve(loader, 'index.d.ts'),
		)
		expect(
			Object.keys(generation.inputs).some((path) => path.includes('/@types/node/crypto.d.ts')),
		).toBe(true)
		expect(generation.files['index.d.mts']).not.toContain('observe')
		expect(await readFile(config, 'utf8')).toBe(original)
	}, 30_000)

	it('keeps implementation JSON out of ambient contracts and freezes public JSON dependencies', async () => {
		const directory = await fixture()
		const counter = resolve(directory, 'counter.ts')
		const internal = resolve(directory, 'internal.json')
		const publicData = resolve(directory, 'public.json')
		await writeFile(internal, '{"version":"internal"}\n')
		const publicSource = '{"enabled":true,"nested":{"count":1},"list":["one"]}\n'
		await writeFile(publicData, publicSource)
		const source = await readFile(counter, 'utf8')
		await writeFile(
			counter,
			"import internal from './internal.json'\nimport publicData from './public.json'\n" +
				source.replace(
					'self():this',
					'version():string{return internal.version} jsonContract(value:typeof publicData):typeof publicData{return value} self():this',
				),
		)
		const generate = () =>
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: counter, className: 'Counter', definition }],
			})
		const generation = await generate()
		expect(Object.keys(generation.inputs)).toEqual(expect.arrayContaining([internal, publicData]))
		const dependencies = generation.definitionInputs[pluginDefinitionIndexKey(definition)]!
		expect(dependencies).toContain(publicData)
		expect(dependencies).not.toContain(internal)
		expect(Object.keys(generation.files).some((path) => path.endsWith('/internal.json'))).toBe(
			false,
		)
		expect(
			Object.entries(generation.files).find(([path]) => path.endsWith('/public.json'))?.[1],
		).toBe(publicSource)
		await writeFile(internal, '{"version":"changed implementation"}\n')
		const changed = await generate()
		expect(changed.manifest.definitions[0]!.contracts).toEqual(
			generation.manifest.definitions[0]!.contracts,
		)
		const consumer = resolve(directory, 'consumer')
		await mkdir(consumer)
		for (const [path, text] of Object.entries(generation.files)) {
			const file = resolve(consumer, path)
			await mkdir(dirname(file), { recursive: true })
			await writeFile(file, text)
		}
		await Promise.all([rm(internal), rm(publicData)])
		await writeFile(
			resolve(consumer, 'usage.mts'),
			`import type {CounterInstance} from './index.mjs'
declare const counter:CounterInstance
const enabled:boolean=counter.jsonContract({enabled:false,nested:{count:2},list:['two']}).enabled
// @ts-expect-error JSON declaration references preserve their original member types.
counter.jsonContract({enabled:true,nested:{count:'invalid'},list:[]})
void enabled
`,
		)
		await writeFile(
			resolve(consumer, 'tsconfig.json'),
			JSON.stringify({
				extends: resolve(root, 'tsconfig.json'),
				compilerOptions: { strictNullChecks: true },
				files: ['usage.mts'],
				include: [],
			}),
		)
		await run(
			process.execPath,
			[
				resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
				'--project',
				resolve(consumer, 'tsconfig.json'),
				'--pretty',
				'false',
			],
			{ maxBuffer: 1024 * 1024 },
		)
	}, 30_000)

	it('describes imported JSON configuration defaults and changes their configuration contract', async () => {
		const directory = await fixture()
		const counter = resolve(directory, 'counter.ts')
		const defaults = resolve(directory, 'defaults.json')
		await writeFile(defaults, '{"count":2}\n')
		const source = await readFile(counter, 'utf8')
		await writeFile(
			counter,
			"import defaults from './defaults.json'\n" +
				source.replace('const DEFAULT_COUNT = 2', 'const DEFAULT_COUNT = defaults.count'),
		)
		const generate = () =>
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: counter, className: 'Counter', definition }],
			})
		const before = await generate()
		expect(before.files['index.d.mts']).toContain('defaults.count')
		expect(before.files['index.d.mts']).toContain('{"count":2}')
		expect(before.definitionInputs[pluginDefinitionIndexKey(definition)]).toContain(defaults)
		await writeFile(defaults, '{"count":5}\n')
		const after = await generate()
		expect(after.files['index.d.mts']).toContain('{"count":5}')
		expect(after.manifest.definitions[0]!.contracts.config).not.toBe(
			before.manifest.definitions[0]!.contracts.config,
		)
	}, 30_000)

	it('isolates independent definitions and propagates public declaration dependencies', async () => {
		const directory = await fixture()
		const counter = resolve(directory, 'counter.ts'),
			sibling = resolve(directory, 'sibling.ts'),
			payload = resolve(directory, 'payload.ts')
		await writeFile(
			resolve(directory, 'metrics.ts'),
			"import type {Counter} from './counter.ts'; export const instances:Counter[]=[]; export function record(_value:object):void{}\n",
		)
		const counterSource = await readFile(counter, 'utf8')
		await writeFile(
			counter,
			"import {record} from './metrics.ts'\n" +
				counterSource.replace(
					'this.brand++; return other',
					'record(this); this.brand++; return other',
				),
		)
		const independent =
			"import {BasePlugin,Plugin} from '@pluxel/core'; import * as v from 'valibot'; import {record} from './metrics.ts'; @Plugin() export class Sibling extends BasePlugin { private readonly config=this.configs.use(v.object({enabled:v.optional(v.boolean(),true)})); touch():void{record(this)} }\n"
		await writeFile(sibling, independent)
		const siblingDefinition = {
			...definition,
			entry: { ...definition.entry, path: 'sibling.ts' },
			exportName: 'Sibling',
		}
		const definitions = [
			{ moduleId: counter, className: 'Counter', definition },
			{ moduleId: sibling, className: 'Sibling', definition: siblingDefinition },
		]
		const generate = () => generatePluginControl({ root: directory, definitions })
		const contracts = (generation: Awaited<ReturnType<typeof generate>>, name: string) =>
			generation.manifest.definitions.find((entry) => entry.exportName === name)!.contracts
		const before = await generate()
		expect(before.definitionInputs[pluginDefinitionIndexKey(definition)]).toContain(payload)
		expect(before.definitionInputs[pluginDefinitionIndexKey(siblingDefinition)]).not.toContain(
			payload,
		)
		expect(before.definitionInputs[pluginDefinitionIndexKey(siblingDefinition)]).not.toContain(
			counter,
		)
		await writeFile(payload, 'export interface Payload { readonly id: number }\n')
		const changed = await generate()
		expect(contracts(changed, 'Counter').instance).not.toBe(contracts(before, 'Counter').instance)
		expect(contracts(changed, 'Counter').config).toBe(contracts(before, 'Counter').config)
		expect(contracts(changed, 'Sibling')).toEqual(contracts(before, 'Sibling'))
		await writeFile(
			sibling,
			"import type {Counter} from './counter.ts'\n" +
				independent.replace(
					'touch():void',
					'peer(value:Counter):Counter{return value} touch():void',
				),
		)
		const related = await generate()
		expect(related.definitionInputs[pluginDefinitionIndexKey(siblingDefinition)]).toContain(payload)
		await writeFile(payload, 'export interface Payload { readonly id: boolean }\n')
		const relatedChanged = await generate()
		expect(contracts(relatedChanged, 'Sibling').instance).not.toBe(
			contracts(related, 'Sibling').instance,
		)
		expect(contracts(relatedChanged, 'Sibling').config).toBe(contracts(related, 'Sibling').config)
	}, 45_000)

	it('preserves author JSDoc through comment-stripping projects without making local contracts depend on comments', async () => {
		const directory = await fixture()
		const config = resolve(directory, 'tsconfig.json')
		const configured = JSON.parse(await readFile(config, 'utf8'))
		configured.compilerOptions.removeComments = true
		configured.compilerOptions.stripInternal = true
		const originalConfig = JSON.stringify(configured)
		await writeFile(config, originalConfig)
		const file = resolve(directory, 'counter.ts')
		const classDocumentation = `/** Counter author entry.
 * @example const current = counter.self()
 * @deprecated Author migration guidance.
 */`
		const methodDocumentation = `/** Author method contract.
 * @param other Another original Counter instance.
 * @returns The original supplied instance.
 * @example counter.same(counter)
 */`
		const original = await readFile(file, 'utf8')
		const documented = original
			.replace(
				'const CounterConfig =',
				'/** Author Schema definition and defaults. */\nconst CounterConfig =',
			)
			.replace(
				'export abstract class BusinessBase extends BasePlugin { inherited',
				'/** Author business base contract. */\nexport abstract class BusinessBase extends BasePlugin {\n /** Author inherited generic method. */\n inherited',
			)
			.replace(
				'export class NativeHandle',
				'/** Author nominal handle contract. */\nexport class NativeHandle',
			)
			.replace(
				'@Plugin(BusinessBase)',
				`const EXAMPLE_DOCUMENTATION = '/** Not attached author documentation. */'\n${classDocumentation}\n@Plugin(BusinessBase)`,
			)
			.replace(
				'private brand = 0',
				'/** @internal Author internal member. */\n internalOnly():void {}\n private brand = 0',
			)
			.replace(
				'private readonly config =',
				'/** Author managed configuration source. */\n private readonly config =',
			)
			.replace(
				'readonly part =',
				'/** Author Part property.\n  * @deprecated Author Part migration guidance.\n  */\n readonly part =',
			)
			.replace('same(other:Counter)', `${methodDocumentation}\n same(other:Counter)`)
		await writeFile(file, documented)
		const payload = resolve(directory, 'payload.ts')
		const payloadDocumentation =
			'/** Author associated Payload contract. */\nexport interface Payload {\n /** Author Payload identity. */\n readonly id: string\n}\n'
		await writeFile(payload, payloadDocumentation)
		const generate = () =>
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: file, className: 'Counter', definition }],
			})
		const before = await generate()
		const index = before.files['index.d.mts']!
		expect(index).toContain(`${classDocumentation}\nexport type CounterInstance`)
		expect(index).toContain(`${classDocumentation}\nexport declare const Counter`)
		expect(index).not.toContain('Not attached author documentation')
		expect(index).toContain('Schema input before validation, defaults and transforms')
		expect(index).toContain('Validated Schema output after defaults and transforms')
		expect(index).toContain('{@link CounterConfigDeclaration}')
		expect(index).toContain('Author managed configuration source')
		expect(index).toContain('Author Schema definition and defaults')
		const declarations = Object.entries(before.files)
			.filter(([path]) => path.startsWith('types/') && /\.d\.[cm]?ts$/.test(path))
			.map(([, code]) => code)
			.join('\n')
		for (const marker of [
			'Counter author entry.',
			'Author method contract.',
			'@param other Another original Counter instance.',
			'@returns The original supplied instance.',
			'@example counter.same(counter)',
			'@deprecated Author Part migration guidance.',
			'Author business base contract.',
			'Author inherited generic method.',
			'Author nominal handle contract.',
			'Author associated Payload contract.',
			'Author Payload identity.',
		])
			expect(declarations).toContain(marker)
		expect(declarations).not.toContain('internalOnly')
		expect(declarations).not.toContain('this.brand++')
		expect(declarations).not.toContain('control generation must never evaluate implementation')
		await writeFile(
			file,
			documented
				.replaceAll('Author', 'Revised author')
				.replace('Counter author entry.', 'Revised Counter author entry.'),
		)
		await writeFile(payload, payloadDocumentation.replaceAll('Author', 'Revised author'))
		const revised = await generate()
		expect(revised.files['index.d.mts']).toContain('Revised Counter author entry.')
		expect(revised.snapshot).not.toBe(before.snapshot)
		expect(revised.manifest.definitions[0]!.contracts).toEqual(
			before.manifest.definitions[0]!.contracts,
		)
		expect(await readFile(config, 'utf8')).toBe(originalConfig)
	}, 30_000)

	it('emits complete native class declarations and readable config witnesses without evaluating source', async () => {
		const directory = await fixture()
		const generation = await generatePluginControl({
			root: directory,
			definitions: [
				{ moduleId: resolve(directory, 'counter.ts'), className: 'Counter', definition },
			],
		})
		await expect(
			verifyPluginControlMaterial(generation.manifest, generation.files),
		).resolves.toEqual(generation.manifest)
		expect(generation.files['index.mjs']).not.toMatch(/import|CounterPart|throw new/)
		expect(generation.files['index.d.mts']).toContain('ConfigDeclaration')
		expect(generation.files['index.d.mts']).toContain('DEFAULT_COUNT = 2')
		expect(generation.files['index.d.mts']).toContain('v.minValue(0)')
		expect(generation.files['index.d.mts']).toContain('"path": readonly ["part"]')
		const consumer = resolve(directory, 'consumer')
		await mkdir(consumer)
		for (const [path, text] of Object.entries(generation.files)) {
			const file = resolve(consumer, path)
			await mkdir(dirname(file), { recursive: true })
			await writeFile(file, text)
		}
		await Promise.all(
			['counter.ts', 'part.ts', 'payload.ts', 'ambient.d.ts', 'detail.d.ts'].map((path) =>
				rm(resolve(directory, path)),
			),
		)
		await writeFile(
			resolve(consumer, 'usage.mts'),
			`import {Counter} from './index.mjs'
import type {CounterInstance,CounterConfigInput,CounterConfigOutput} from './index.mjs'
import type {ScriptSdk} from '@pluxel/host/agent'
declare const sdk:ScriptSdk
const counter=(await sdk.plugin(Counter).instance()).unwrap()
const same:CounterInstance=counter.same(counter)
const self:CounterInstance=counter.self()
counter.part.owner().same(counter)
const inherited:{id:string}=counter.inherited({id:'yes'})
const exact:'value'=counter.generic({id:'value' as const}).id
const text:string=counter.overload('a')
const number:number=counter.overload(1)
const input:CounterConfigInput={}
const output:CounterConfigOutput={count:2,note:'',part:{enabled:true}}
counter.ambient({rank:1,label:'kept'})
// @ts-expect-error Explicit ambient declaration roots remain part of the closed material.
counter.ambient({label:'missing rank'})
// @ts-expect-error Invalid original Payload member.
counter.payload({id:1})
// @ts-expect-error Private nominal state cannot be forged structurally.
const forged:CounterInstance={same:counter.same,self:counter.self}
// @ts-expect-error Output includes defaults and required Part output.
const missing:CounterConfigOutput={}
void [same,self,inherited,exact,text,number,input,output,forged,missing]
`,
		)
		await writeFile(
			resolve(consumer, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2023',
					module: 'ESNext',
					moduleResolution: 'bundler',
					lib: ['ES2024', 'DOM', 'DOM.Iterable', 'ESNext.Disposable'],
					types: ['node'],
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					allowImportingTsExtensions: true,
					customConditions: ['@pluxel/source'],
				},
				files: ['usage.mts'],
			}),
		)
		await run(
			process.execPath,
			[
				resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
				'--project',
				resolve(consumer, 'tsconfig.json'),
				'--pretty',
				'false',
			],
			{ maxBuffer: 1024 * 1024 },
		)
	}, 30_000)

	it('rejects a scalar configuration output before publishing an invalid descriptor declaration', async () => {
		const directory = await fixture()
		const file = resolve(directory, 'counter.ts')
		const counterSource = await readFile(file, 'utf8')
		await writeFile(
			file,
			counterSource.replace(/const CounterConfig = [^\n]+/, 'const CounterConfig = v.string()'),
		)
		await expect(
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: file, className: 'Counter', definition }],
			}),
		).rejects.toThrow(/Type 'string' does not satisfy the constraint 'object'/)
	}, 30_000)

	it('aliases descriptor names that shadow the deterministic renderer or declaration helpers', async () => {
		const directory = await fixture()
		const generation = await generatePluginControl({
			root: directory,
			definitions: [
				'Object',
				'PluginDescriptor',
				'__ControlInput',
				'Counter',
				'CounterConfigInput',
			].map((exportName) => ({
				moduleId: resolve(directory, 'counter.ts'),
				className: 'Counter',
				definition: { ...definition, exportName },
			})),
		})
		const names = generation.manifest.definitions.map((entry) => entry.exportName)
		expect(names).not.toContain('Object')
		expect(names).not.toContain('PluginDescriptor')
		expect(names).not.toContain('__ControlInput')
		expect(names).not.toContain('CounterConfigInput')
		const namespace = await import(
			`data:text/javascript,${encodeURIComponent(generation.files['index.mjs']!)}`
		)
		expect(Object.keys(namespace).sort()).toEqual(names.toSorted())
	}, 30_000)

	it('routes control generation through the real Rolldown Plugin pipeline', async () => {
		const directory = await fixture()
		const semantics = createPluginSemanticsPlugin({ root: directory })
		const build = await rolldown({
			input: resolve(directory, 'counter.ts'),
			external: (id) => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0'),
			plugins: [
				semantics.plugin,
				configSourcePlugin(),
				createPluginControlPlugin({ root: directory, semantics }),
			],
			transform: {
				decorator: { legacy: true, emitDecoratorMetadata: false },
				typescript: { removeClassFieldsWithoutInitializer: true },
			},
		})
		try {
			await build.write({ dir: resolve(directory, 'dist'), format: 'esm' })
		} finally {
			await build.close()
		}
		const manifest = JSON.parse(
			await readFile(resolve(directory, 'dist/control/manifest.json'), 'utf8'),
		)
		expect(manifest.definitions.map((entry: { exportName: string }) => entry.exportName)).toEqual([
			'Counter',
		])
		const control = await import(pathToFileURL(resolve(directory, 'dist/control/index.mjs')).href)
		expect(control.Counter.definition).toEqual(definition)
		expect(Object.isFrozen(control.Counter.definition.entry)).toBe(true)
	}, 30_000)

	it('changes the instance contract for a type-only dependency while presentation changes preserve contracts', async () => {
		const directory = await fixture()
		const generate = () =>
			generatePluginControl({
				root: directory,
				definitions: [
					{ moduleId: resolve(directory, 'counter.ts'), className: 'Counter', definition },
				],
			})
		const before = await generate()
		const file = resolve(directory, 'counter.ts')
		await writeFile(file, `// presentation only\n${await readFile(file, 'utf8')}`)
		const comment = await generate()
		expect(comment.manifest.definitions[0]!.contracts).toEqual(
			before.manifest.definitions[0]!.contracts,
		)
		await writeFile(
			resolve(directory, 'payload.ts'),
			'export interface Payload { readonly id: number }\n',
		)
		const changed = await generate()
		expect(changed.manifest.definitions[0]!.contracts.instance).not.toBe(
			before.manifest.definitions[0]!.contracts.instance,
		)
	}, 30_000)

	it('normalizes bigint class literals without losing their value in the instance contract', async () => {
		const directory = await fixture()
		const file = resolve(directory, 'counter.ts')
		const original = await readFile(file, 'utf8')
		const source = original.replace(
			'private brand = 0',
			'readonly literal = 1n\n private brand = 0',
		)
		await writeFile(file, source)
		const generate = () =>
			generatePluginControl({
				root: directory,
				definitions: [{ moduleId: file, className: 'Counter', definition }],
			})
		const before = await generate()
		await writeFile(file, source.replace('readonly literal = 1n', 'readonly literal = 2n'))
		const changed = await generate()
		expect(changed.manifest.definitions[0]!.contracts.instance).not.toBe(
			before.manifest.definitions[0]!.contracts.instance,
		)
		expect(changed.manifest.definitions[0]!.contracts.config).toBe(
			before.manifest.definitions[0]!.contracts.config,
		)
	}, 30_000)
})
