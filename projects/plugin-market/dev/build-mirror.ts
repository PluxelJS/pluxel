import { resolve } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { build } from 'esbuild'
import { projectRoot } from './session.ts'

const migrations = readMigrationFiles({ migrationsFolder: resolve(projectRoot, 'migrations') }).map(
	({ sql }) => sql.join('\n'),
)

await build({
	stdin: {
		contents: `import { main } from './src/catalog/mirror'; await main(${JSON.stringify(migrations)})`,
		resolveDir: projectRoot,
	},
	outfile: process.argv[2] ?? resolve(projectRoot, 'dist/mirror.mjs'),
	platform: 'node',
	format: 'esm',
	target: 'node24',
	bundle: true,
})
