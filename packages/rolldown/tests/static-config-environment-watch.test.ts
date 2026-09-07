import { writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { watch, type RolldownWatcher, type RolldownWatcherEvent } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { staticConfigEnvironmentDeclarationPlugin } from '../src/rolldown/plugins/staticConfigEnvironmentPlugin'
import type { StaticRuntimeDeclarationFacts } from '../src/rolldown/plugins/staticConfigEnvironment'

describe('static config environment production watch', () => {
	it('reparses declaration facts when only an imported schema changes', async () => {
		await using fixture = await createFixture({
			'schema.ts': schemaSource('First endpoint.'),
			'plugin.ts': `
				import { DemoConfig } from './schema'
				export { DemoConfig } from './schema'
				export class DemoPlugin {
					readonly settings = this.configs.use(DemoConfig)
				}
				export const plugins = [DemoPlugin] as const
			`,
			'entry.ts': `
				import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
				import { DemoConfig, DemoPlugin, plugins } from './plugin'
				export default defineStaticRuntime({
					name: 'watch-fixture',
					plugins,
					configEnvironmentBootstrap: [
						bindConfigEnvironment(DemoPlugin, DemoConfig, { endpoint: 'APP_ENDPOINT' }),
					],
				})
			`,
		})
		const entry = fixture.getPath('entry.ts')
		const declarations: StaticRuntimeDeclarationFacts[] = []
		const watcher = watch({
			input: entry,
			external(id) {
				return !id.startsWith('.') && !id.startsWith('/')
			},
			plugins: [
				staticConfigEnvironmentDeclarationPlugin({
					entry,
					onDeclaration(facts) {
						declarations.push(facts)
					},
				}),
			],
			output: { dir: fixture.getPath('dist'), format: 'esm' },
			watch: { skipWrite: true },
		})
		try {
			await waitForBuild(watcher)
			expect(declarations.at(-1)?.environmentExample).toContain('First endpoint.')

			const rebuilt = waitForBuild(watcher)
			await writeFile(fixture.getPath('schema.ts'), schemaSource('Second endpoint.'))
			await rebuilt

			expect(declarations.length).toBeGreaterThanOrEqual(2)
			expect(declarations.every((facts) => facts.targets.length === 1)).toBe(true)
			expect(declarations.at(-1)?.environmentExample).toContain('Second endpoint.')
			expect(declarations.at(-1)?.environmentExample).not.toContain('First endpoint.')
		} finally {
			await watcher.close()
		}
	})
})

function schemaSource(description: string): string {
	return `
		import * as v from 'valibot'
		import * as f from 'valibot-form'
		export const DemoConfig = v.object({
			endpoint: v.pipe(v.string(), f.formMeta({ description: ${JSON.stringify(description)} })),
		})
	`
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
