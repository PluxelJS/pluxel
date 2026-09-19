import { createHash } from 'node:crypto'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { importViteSsrModule } from '@pluxel/host-dev/vite'
import { createServer } from 'vite'
import { expect, it } from 'vitest'
import { vitePreset } from '../src/vite'

it('loads checked database migration facts through the official Vite preset', async () => {
	const sql = 'CREATE TABLE items (id text PRIMARY KEY);'
	const checksum = createHash('sha256').update(sql).digest('hex')
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({ name: 'database-source-fixture', type: 'module' }),
		'app.ts': 'export default { plugins: [] }',
		'database.ts': `import { defineDatabase } from '@pluxel/services/database'
export const database = defineDatabase({ schema: {} })`,
		'drizzle/0000_initial.sql': sql,
		'drizzle/pluxel-migrations.json': JSON.stringify({
			version: 2,
			lineage: 'fixture',
			migrations: [{ id: '0000_initial', file: '0000_initial.sql', checksum }],
		}),
		'node_modules/@pluxel/services/package.json': JSON.stringify({
			name: '@pluxel/services',
			type: 'module',
			exports: { './database': './database.js' },
		}),
		'node_modules/@pluxel/services/database.js':
			'export const defineDatabase = (_input, artifact) => artifact',
	})
	const server = await createServer({
		root: fixture.path,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true },
		appType: 'custom',
		plugins: vitePreset({ entry: 'app.ts' }),
	})
	try {
		const loaded = await importViteSsrModule<{ database: unknown }>(
			server,
			`${fixture.path}/database.ts`,
		)
		expect(loaded.database).toEqual({
			evolution: 'migrations',
			lineage: 'fixture',
			migrations: [{ id: '0000_initial', checksum, sql }],
		})
	} finally {
		await server.close()
	}
})
