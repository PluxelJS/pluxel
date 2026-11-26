import { readFile, writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { rolldown, watch, type RolldownWatcher, type RolldownWatcherEvent } from 'rolldown'
import { describe, expect, it } from 'vitest'
import {
	renderStaticApplicationEnvironmentExample,
	writeStaticConfigEnvironmentExample,
} from '../src/cli/static-config-environment-output'
import { staticConfigEnvironmentDeclarationPlugin } from '../src/rolldown/plugins/staticConfigEnvironmentPlugin'
import type { StaticRuntimeDeclarationFacts } from '../src/rolldown/plugins/staticConfigEnvironment'

describe('static config environment production watch', () => {
	it('rewrites the environment example after a dependency outside the bundle graph changes', async () => {
		await using fixture = await createFixture({
			'factories.ts': `
				export * as vb from 'valibot'
				export { number as numeric, pipe as chain } from 'valibot'
				export { formMeta as present } from 'valibot-form'
			`,
			'barrel.ts': "export * from 'valibot'; export * from './schema'",
			'constraints.ts': constraintsSource(1024, 'First port.'),
			'schema.ts': `
				import { vb as schemas, numeric, chain, present } from './factories'
				import { Minimum, Description } from './constraints'
				throw new Error('static projection must not execute this module')
				function positive(port: number) { return port > 0 }
				const makeNumber = numeric
				export const DemoConfig = schemas.strictObject({
					port: chain(makeNumber(), schemas.integer(), schemas.minValue(Minimum), present({ description: Description })),
					other: chain(schemas.number(), schemas.check(positive)),
				})
			`,
			'plugin.ts': `
				import { envBinding } from '@pluxel/host/bindings'
				import { DemoConfig } from './barrel'
				export class DemoPlugin {
					readonly settings = this.configs.use(DemoConfig)
				}
				export const plugins = [{
					plugin: DemoPlugin,
					envBindings: [
						envBinding({ config: { schema: DemoConfig, mapping: { port: 'APP_PORT' } } }),
					],
				}] as const
			`,
			'entry.ts': `
				import { defineHostApplication } from '@pluxel/host/application'
				import { plugins } from './plugin'
				export default defineHostApplication(() => ({
					name: 'watch-fixture',
					plugins,
				}))
			`,
		})
		const entry = fixture.getPath('entry.ts')
		const outDir = fixture.getPath('dist')
		const output = fixture.getPath('dist/.env.example')
		const declarations: StaticRuntimeDeclarationFacts[] = []
		let ownedExisting = false
		const watcher = watch({
			input: entry,
			external: isBareImport,
			plugins: [
				{
					name: 'external-schema-fixture',
					resolveId(id) {
						if (id === './schema') return { id: fixture.getPath('schema.ts'), external: true }
						return null
					},
				},
				staticConfigEnvironmentDeclarationPlugin({
					entry,
					onDeclaration(facts) {
						declarations.push(facts)
					},
				}),
				{
					name: 'write-environment-example-fixture',
					async writeBundle(_, bundle) {
						ownedExisting = await writeStaticConfigEnvironmentExample({
							outDir,
							bundle,
							content: renderStaticApplicationEnvironmentExample(
								declarations.at(-1)?.environmentExample,
							),
							ownedExisting,
						})
					},
				},
			],
			output: { dir: outDir, format: 'esm' },
		})
		try {
			await waitForBuild(watcher)
			expect(await readFile(output, 'utf8')).toContain(
				'# First port.\n# Input: number (finite integer, >= 1024)\n# APP_PORT=',
			)

			const rebuilt = waitForBuild(watcher)
			await writeFile(fixture.getPath('constraints.ts'), constraintsSource(2048, 'Second port.'))
			await rebuilt

			expect(declarations.length).toBeGreaterThanOrEqual(2)
			expect(declarations.every((facts) => facts.targets.length === 1)).toBe(true)
			const after = await readFile(output, 'utf8')
			expect(after).toContain(
				'# Second port.\n# Input: number (finite integer, >= 2048)\n# APP_PORT=',
			)
			expect(after).not.toContain('First port.')
		} finally {
			await watcher.close()
		}
	})

	it.each(['config', 'vault'])(
		'locates an unsupported nested %s input in its defining file',
		async (kind) => {
			const leaf = "import * as v from 'valibot';\nexport const Input = v.unknown()"
			await using fixture = await createFixture({
				'leaf.ts': leaf,
				'schema.ts':
					"import * as v from 'valibot'; import { Input } from './leaf'; export const Settings = v.object({ nested: v.object({port:Input}) })",
				'entry.ts': `import {defineHostApplication, envBinding} from '@pluxel/host'; import {Settings} from './schema'; class Plugin {}
				export default defineHostApplication(() => ({plugins:[{plugin: Plugin, envBindings: [envBinding({${kind}:{schema:Settings,mapping:{nested:{port:'APP_PORT'}}}})]}]}))`,
			})
			const entry = fixture.getPath('entry.ts')
			const make = () =>
				rolldown({
					input: entry,
					external: isBareImport,
					plugins: [staticConfigEnvironmentDeclarationPlugin({ entry })],
				})
			const build = async () => {
				const bundle = await make()
				try {
					await bundle.generate({ format: 'esm' })
				} finally {
					await bundle.close()
				}
			}
			const start = leaf.indexOf('v.unknown()')
			await expect(build()).rejects.toThrow(
				`path ["nested","port"] [unsupported_schema] at ${fixture.getPath('leaf.ts')}:2:22 (${start}..${start + 11})`,
			)
		},
	)

	it.each([
		{
			expression:
				"import * as v from 'third-party-schema'\nexport const Schema = v.object({ port: v.number() })",
			operand: 'v.object',
			reason:
				'cannot resolve v from third-party-schema to a Valibot or valibot-form factory import',
		},
		{
			expression:
				"import * as v from './factories'\nexport const Schema = v.object({ port: v.number() })",
			operand: 'v.object',
			reason: 'cannot resolve v from ./factories to a Valibot or valibot-form factory import',
		},
		{
			expression:
				"import * as v from 'valibot'\nexport const Schema = v.object({ port: v.number(), ...readEntries() })",
			operand: '...readEntries()',
			reason: 'dynamic spread may provide or overwrite the requested property',
		},
	])(
		'locates an unsupported schema expression in a build: $operand',
		async ({ expression, operand, reason }) => {
			const code = `
			import { defineHostApplication, envBinding } from '@pluxel/host'
			import { Schema } from './schema'
			class DemoPlugin {}
			export default defineHostApplication(() => ({
				plugins: [{plugin: DemoPlugin, envBindings: [
					envBinding({config: {schema: Schema, mapping: {port: 'APP_PORT'}}})
				]}],
			}))
		`
			await using fixture = await createFixture({
				'entry.ts': code,
				'schema.ts': expression,
				'factories.ts': "export * from 'valibot'; export * from 'third-party-schema'",
			})
			const entry = fixture.getPath('entry.ts')
			const id = fixture.getPath('schema.ts')
			const build = async () => {
				const bundle = await rolldown({
					input: entry,
					external: isBareImport,
					plugins: [staticConfigEnvironmentDeclarationPlugin({ entry })],
				})
				try {
					await bundle.generate({ format: 'esm' })
				} finally {
					await bundle.close()
				}
			}
			const start = expression.indexOf(operand)
			const column = start - expression.indexOf('\n')
			const failure: unknown = await build().catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(Error)
			const message = (failure as Error).message
			expect(message).toContain(entry)
			expect(message).toContain('plugins[0].envBindings[0].config.mapping cannot bind APP_PORT')
			expect(message).toContain(
				`path ["port"] [unsupported_schema] at ${id}:2:${column} (${start}..${start + operand.length}): ${reason}`,
			)
		},
	)
})

function isBareImport(id: string): boolean {
	return !id.startsWith('.') && !id.startsWith('/')
}

function constraintsSource(minimum: number, description: string): string {
	return `export const Minimum = ${minimum}; export const Description = ${JSON.stringify(description)}`
}

function waitForBuild(watcher: RolldownWatcher): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => finish(new Error('Timed out waiting for Rolldown watch build')),
			10_000,
		)
		const onEvent = async (event: RolldownWatcherEvent): Promise<void> => {
			if (event.code === 'BUNDLE_END') {
				await event.result.close()
				return
			}
			if (event.code === 'ERROR') {
				await event.result.close()
				finish(event.error)
				return
			}
			if (event.code === 'END') finish()
		}
		function finish(error?: Error): void {
			clearTimeout(timeout)
			watcher.off('event', onEvent)
			if (error) reject(error)
			else resolve()
		}
		watcher.on('event', onEvent)
	})
}
