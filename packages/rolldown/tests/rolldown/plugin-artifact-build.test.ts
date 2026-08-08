import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture } from 'fs-fixture'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { pluginArtifactBuildPlugin } from '../../src/rolldown/plugins/pluginArtifactBuildPlugin.ts'
import { databaseSourceVitePlugin } from '../../src/vite/database-source.ts'

describe('pluginArtifactBuildPlugin', () => {
	it('embeds checked migrations without exposing an author artifact argument', async () => {
		const migration = 'CREATE TABLE items (id text PRIMARY KEY)'
		const checksum = createHash('sha256').update(migration).digest('hex')
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ name: 'database-fixture', type: 'module' }),
			'src/index.ts':
				"import { defineDatabase } from '@pluxel/runtime/database'\nexport const database = defineDatabase({ schema: {} })\n",
			'drizzle/0000_initial.sql': `${migration}\n`,
			'drizzle/pluxel-migrations.json': JSON.stringify({
				version: 2,
				lineage: 'main',
				migrations: [{ id: '0000_initial', file: '0000_initial.sql', checksum }],
			}),
		})
		const bundle = await rolldown({
			input: `${fixture.path}/src/index.ts`,
			external: ['@pluxel/runtime/database'],
			plugins: [pluginArtifactBuildPlugin({ root: fixture.path, buildDir: 'dist' })],
		})
		await bundle.write({ dir: `${fixture.path}/dist`, format: 'esm' })
		await bundle.close()

		const server = await readFile(`${fixture.path}/dist/index.js`, 'utf8')
		expect(server).toContain('main')
		expect(server).toContain(checksum)
		expect(server).toContain(migration)
		await expect(
			readFile(`${fixture.path}/dist/database/migrations/0000_initial.sql`, 'utf8'),
		).resolves.toBe(`${migration}\n`)
	})

	it('builds reset-on-schema-change without a checked-in migration directory', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-reset-build-test-'))
		await mkdir(join(root, 'src'), { recursive: true })
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'reset-database-fixture', type: 'module' }),
			'utf8',
		)
		await mkdir(join(root, 'node_modules/@pluxel/runtime'), { recursive: true })
		await writeFile(
			join(root, 'node_modules/@pluxel/runtime/package.json'),
			JSON.stringify({
				name: '@pluxel/runtime',
				type: 'module',
				exports: { './database': './database.js' },
			}),
			'utf8',
		)
		await writeFile(
			join(root, 'node_modules/@pluxel/runtime/database.js'),
			'export const defineDatabase = (input) => input\n',
			'utf8',
		)
		await writeFile(
			join(root, 'src/index.ts'),
			[
				"import { pgTable, text } from 'drizzle-orm/pg-core'",
				"import { defineDatabase } from '@pluxel/runtime/database'",
				"export const items = pgTable('items', { id: text('id').primaryKey() })",
				"export const database = defineDatabase({ schema: { items }, evolution: 'reset-on-schema-change' })",
			].join('\n'),
			'utf8',
		)

		try {
			const bundle = await rolldown({
				input: join(root, 'src/index.ts'),
				external: ['@pluxel/runtime/database', 'drizzle-orm/pg-core'],
				plugins: [pluginArtifactBuildPlugin({ root, buildDir: 'dist' })],
			})
			await bundle.write({ dir: join(root, 'dist'), format: 'esm' })
			await bundle.close()

			const server = await readFile(join(root, 'dist/index.js'), 'utf8')
			expect(server).toContain('reset-on-schema-change')
			expect(server).toMatch(/reset-[a-f0-9]{40}/)
			const manifest = JSON.parse(
				await readFile(join(root, 'dist/database/migrations/pluxel-migrations.json'), 'utf8'),
			) as { evolution: string; lineage: string }
			expect(manifest.evolution).toBe('reset-on-schema-change')
			expect(server).toContain(manifest.lineage)
			await expect(
				readFile(join(root, 'dist/database/migrations/0000_baseline.sql'), 'utf8'),
			).resolves.toContain('CREATE TABLE "items"')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('injects the generated reset baseline in the Vite server source transform', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-database-reset-source-test-'))
		await mkdir(join(root, 'src'), { recursive: true })
		await mkdir(join(root, 'node_modules/@pluxel/runtime'), { recursive: true })
		await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
		await writeFile(
			join(root, 'node_modules/@pluxel/runtime/package.json'),
			JSON.stringify({
				name: '@pluxel/runtime',
				type: 'module',
				exports: { './database': './database.js' },
			}),
			'utf8',
		)
		await writeFile(
			join(root, 'node_modules/@pluxel/runtime/database.js'),
			'export const defineDatabase = (input) => input\n',
			'utf8',
		)
		await writeFile(
			join(root, 'src/index.ts'),
			[
				"import { pgTable, text } from 'drizzle-orm/pg-core'",
				"import { defineDatabase } from '@pluxel/runtime/database'",
				"export const items = pgTable('items', { id: text('id').primaryKey() })",
				"export const database = defineDatabase({ schema: { items }, evolution: 'reset-on-schema-change' })",
			].join('\n'),
			'utf8',
		)

		try {
			const bundle = await rolldown({
				input: join(root, 'src/index.ts'),
				external: ['@pluxel/runtime/database', 'drizzle-orm/pg-core'],
				plugins: [databaseSourceVitePlugin({ root })],
			})
			await bundle.write({ dir: join(root, 'dist'), format: 'esm' })
			await bundle.close()

			const server = await readFile(join(root, 'dist/index.js'), 'utf8')
			expect(server).toContain('reset-on-schema-change')
			expect(server).toMatch(/reset-[a-f0-9]{40}/)
			expect(server).toContain('CREATE TABLE')
			await expect(
				readFile(join(root, 'dist/database/migrations/pluxel-migrations.json'), 'utf8'),
			).rejects.toMatchObject({ code: 'ENOENT' })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it('lowers a Node declaration and publishes its Node ESM artifact', async () => {
		await using fixture = await createFixture({
			'src/index.ts':
				"import { defineNodeModule } from '@pluxel/runtime'\nexport const task = defineNodeModule(import.meta.url, './task.ts')\n",
			'src/task.ts': 'export const answer = 42\n',
		})
		const bundle = await rolldown({
			input: `${fixture.path}/src/index.ts`,
			external: ['@pluxel/runtime'],
			plugins: [
				pluginArtifactBuildPlugin({
					root: fixture.path,
					buildDir: 'dist',
					workbench: false,
					node: { minify: false },
				}),
			],
		})
		await bundle.write({ dir: `${fixture.path}/dist`, format: 'esm' })
		await bundle.close()

		const server = await readFile(`${fixture.path}/dist/index.js`, 'utf8')
		const key = server.match(
			/defineNodeModule\(import\.meta\.url,\s*['"]\.\/task\.ts['"],\s*['"]([^'"]+)/,
		)?.[1]
		expect(key).toMatch(/^node-[a-f\d]{16}$/)
		const artifact = await readFile(`${fixture.path}/dist/artifacts/node/${key}.mjs`, 'utf8')
		expect(artifact).toContain('answer')
		expect(artifact).not.toContain('@pluxel/runtime')
	})

	it('lowers a worker declaration through the shared Node artifact pipeline', async () => {
		await using fixture = await createFixture({
			'src/index.ts':
				"import { defineWorkerTask } from '@pluxel/runtime'\nexport const task = defineWorkerTask<number, number>(\n  import.meta.url,\n  './worker.ts',\n)\n",
			'src/worker.ts': 'export default (value: number) => value * 2\n',
		})
		const bundle = await rolldown({
			input: `${fixture.path}/src/index.ts`,
			external: ['@pluxel/runtime'],
			plugins: [
				pluginArtifactBuildPlugin({
					root: fixture.path,
					buildDir: 'dist',
					workbench: false,
					node: { minify: false },
				}),
			],
		})
		await bundle.write({ dir: `${fixture.path}/dist`, format: 'esm' })
		await bundle.close()

		const server = await readFile(`${fixture.path}/dist/index.js`, 'utf8')
		const key = server.match(
			/defineWorkerTask(?:<[^>]+>)?\(import\.meta\.url,\s*['"]\.\/worker\.ts['"],\s*['"]([^'"]+)/,
		)?.[1]
		expect(key).toMatch(/^node-[a-f\d]{16}$/)
		const artifact = await readFile(`${fixture.path}/dist/artifacts/node/${key}.mjs`, 'utf8')
		expect(artifact).toContain('value * 2')
	})

	it('reports controlled native worker residuals to deployment assembly', async () => {
		await using fixture = await createFixture({
			'package.json': JSON.stringify({ dependencies: { 'fake-native': '1.0.0' } }),
			'src/index.ts':
				"import { defineWorkerTask } from '@pluxel/runtime'\nexport const task = defineWorkerTask(import.meta.url, './worker.ts')\n",
			'src/worker.ts': "import native from 'fake-native'\nexport default () => native\n",
			'node_modules/fake-native/package.json': JSON.stringify({
				name: 'fake-native',
				version: '1.0.0',
				main: 'index.js',
				napi: { binaryName: 'fake' },
			}),
			'node_modules/fake-native/index.js': 'module.exports = 42\n',
		})
		const residuals: Array<{ name: string; entry: string }> = []
		const bundle = await rolldown({
			input: `${fixture.path}/src/index.ts`,
			external: ['@pluxel/runtime'],
			plugins: [
				pluginArtifactBuildPlugin({
					root: fixture.path,
					buildDir: 'dist',
					workbench: false,
					node: {
						minify: false,
						onNativeResidual(name, entry) {
							residuals.push({ name, entry })
						},
					},
				}),
			],
		})
		await bundle.write({ dir: `${fixture.path}/dist`, format: 'esm' })
		await bundle.close()

		expect(residuals).toEqual([
			expect.objectContaining({ name: 'fake-native', entry: expect.stringContaining('index.js') }),
		])
	})
})
