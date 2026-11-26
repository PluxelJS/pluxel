import { DatabaseSync } from 'node:sqlite'
import type { MigrationMeta } from 'drizzle-orm/migrator'

// D1 accepts several statements in a single prepared query. Semicolons within
// SQLite literals, quoted identifiers and comments do not start a new PRAGMA.
const lexemes =
	/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$]+|[^\s]/gu

function foreignKeySetting(head: string[]): boolean {
	if (head[0]?.toLowerCase() !== 'pragma') return false
	const nameIndex = head[2] === '.' ? 3 : 1
	const name = head[nameIndex]?.replaceAll(/^["'`[]|["'`\]]$/gu, '').toLowerCase()
	return name === 'foreign_keys' && ['(', '='].includes(head[nameIndex + 1] ?? '')
}

export function assertD1ForeignKeys(migration: MigrationMeta, tag: string): void {
	for (const source of migration.sql) {
		if (!/\bforeign_keys\b/iu.test(source)) continue
		let start = 0
		const head: string[] = []
		for (const match of (source + ';').matchAll(lexemes)) {
			const token = match[0]
			if (token === ';') {
				if (foreignKeySetting(head)) {
					// Let SQLite interpret its own quoted, numeric, and keyword boolean forms.
					using probe = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
					probe.prepare(source.slice(start, match.index)).run()
					if (probe.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) {
						throw new Error(
							`[pluxel/sqlite/d1] ${tag}.sql disables foreign keys. D1 keeps them enabled during migrations, so dropping a parent may cascade to child rows. Rewrite the pending migration to preserve the dependent data before deploying.`,
						)
					}
				}
				start = match.index + 1
				head.length = 0
			} else if (head.length < 5 && !token.startsWith('--') && !token.startsWith('/*')) {
				head.push(token)
			}
		}
	}
}
