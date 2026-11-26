import type { ColumnRef, ScanToken } from 'libpg-query'

type SnapshotObject = { name: string; schema: string }
type SnapshotObjects = Record<string, SnapshotObject>

export type PostgresSnapshot = {
	tables?: Record<string, SnapshotObject & { columns?: Record<string, { default?: unknown }> }>
	enums?: SnapshotObjects
	sequences?: SnapshotObjects
}

async function postgresTokens(source: string, file: string): Promise<ScanToken[]> {
	const { scan } = await import('libpg-query')
	try {
		const { tokens } = await scan(source)
		return tokens.filter(
			(token) => token.tokenName !== 'SQL_COMMENT' && token.tokenName !== 'C_COMMENT',
		)
	} catch (cause) {
		throw new Error(`[database] invalid PostgreSQL migration in ${file}`, { cause })
	}
}

async function parsePostgres(source: string, file: string) {
	const { parse } = await import('libpg-query')
	try {
		return await parse(source)
	} catch (cause) {
		throw new Error(`[database] invalid PostgreSQL migration in ${file}`, { cause })
	}
}

function identifier(token: ScanToken | undefined): string | undefined {
	if (token?.tokenName !== 'IDENT') return undefined
	return token.text.startsWith('"')
		? token.text.slice(1, -1).replaceAll('""', '"')
		: token.text.toLowerCase()
}

function followingDot(tokens: ScanToken[], index: number): number {
	return /^u&"/i.test(tokens[index]!.text) && tokens[index + 1]?.text.toUpperCase() === 'UESCAPE'
		? index + 3
		: index + 1
}

async function nonSchemaColumnQualifiers(
	source: string,
	file: string,
	tokens: ScanToken[],
): Promise<Set<number>> {
	const { stmts } = await parsePostgres(source, file)
	const positions = new Map(tokens.map((token, index) => [token.start, index]))
	const allowed = new Set<number>()
	function visit(node: unknown) {
		if (!node || typeof node !== 'object') return
		if ('ColumnRef' in node) {
			const { fields = [], location } = node.ColumnRef as ColumnRef
			let index = location === undefined ? undefined : positions.get(location)
			// PostgreSQL resolves [database.][schema.]table.column, including table.*.
			// The native AST distinguishes these fields from relations, types and functions.
			for (let field = 0; index !== undefined && field < fields.length - 1; field++) {
				const dot = followingDot(tokens, index)
				if (tokens[dot]?.text !== '.') break
				if (field !== fields.length - 3) allowed.add(tokens[index]!.start)
				index = dot + 1
			}
			return
		}
		for (const child of Object.values(node)) visit(child)
	}
	visit(stmts)
	return allowed
}

export async function validatePostgresMigrationSql(source: string, file: string): Promise<void> {
	if (!/public|pluxel_|u&"/i.test(source)) return
	const tokens = await postgresTokens(source, file)
	let columnQualifiers: Set<number> | undefined
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!
		const dot = followingDot(tokens, index)
		if (tokens[dot]?.text !== '.') continue
		let name = identifier(token)
		// PostgreSQL decodes U& identifiers with an optional UESCAPE clause.
		if (/^u&"/i.test(token.text)) {
			const spelling = tokens
				.slice(index, dot)
				.map((part) => part.text)
				.join(' ')
			const { stmts } = await parsePostgres(`SELECT * FROM ${spelling}`, file)
			const stmt = stmts?.[0]?.stmt
			const relation = stmt && 'SelectStmt' in stmt ? stmt.SelectStmt.fromClause?.[0] : undefined
			if (relation && 'RangeVar' in relation) name = relation.RangeVar.relname
		}
		if (!name || (name !== 'public' && !/^pluxel_[a-z0-9_]+$/.test(name))) continue
		columnQualifiers ??= await nonSchemaColumnQualifiers(source, file, tokens)
		if (columnQualifiers.has(token.start)) continue
		if (name === 'public') {
			throw new Error(`[database] migration must not reference the public schema: ${file}`)
		}
		throw new Error(`[database] migration must not hard-code a physical plugin schema: ${file}`)
	}
}

function namesInSchema(objects: SnapshotObjects | undefined, schema: string): string[] {
	return Object.values(objects ?? {})
		.filter((object) => object.schema === schema)
		.map((object) => object.name)
}

function generatedColumnCast(
	tokens: ScanToken[],
	statement: number,
	cast: ScanToken,
	bytes: Buffer,
	current: PostgresSnapshot,
): boolean {
	const [alter, table, tableName, change, column, columnName, set, action, value] = tokens.slice(
		statement,
		statement + 9,
	)
	if (
		alter?.text !== 'ALTER' ||
		table?.text !== 'TABLE' ||
		change?.text !== 'ALTER' ||
		column?.text !== 'COLUMN' ||
		set?.text !== 'SET'
	)
		return false
	if (action?.text === 'DATA' && value?.text === 'TYPE') return true
	if (action?.text !== 'DEFAULT' || !value) return false
	const tableKey = identifier(tableName)
	const columnKey = identifier(columnName)
	if (!tableKey || !columnKey) return false
	const declared = current.tables?.[`public.${tableKey}`]?.columns?.[columnKey]?.default
	// Kit appends a cast to the declared default when changing a column's enum.
	// A cast already present *inside* an author's raw default stays explicit.
	return (
		declared !== undefined &&
		bytes.toString('utf8', value.start, cast.start).trim() === String(declared).trim()
	)
}

/** Scope only references synthesized by Drizzle Kit in a newly generated migration. */
export async function scopeGeneratedPostgresSql(
	source: string,
	file: string,
	current: PostgresSnapshot,
	previous?: PostgresSnapshot,
): Promise<string> {
	if (!source.includes('"public"')) return source
	const tables = new Set(namesInSchema(current.tables, ''))
	const explicitTables = new Set(namesInSchema(current.tables, 'public'))
	// Kit uses "public" for standalone pgEnum/pgSequence and "" for pgTable.
	// Removed objects appear only in the previous snapshot.
	const enums = new Set([
		...namesInSchema(current.enums, 'public'),
		...namesInSchema(previous?.enums, 'public'),
	])
	const sequences = new Set([
		...namesInSchema(current.sequences, 'public'),
		...namesInSchema(previous?.sequences, 'public'),
	])
	const tokens = await postgresTokens(source, file)
	const bytes = Buffer.from(source)
	const result: Buffer[] = []
	let start = 0
	let statement = 0
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!
		if (token.text === ';') statement = index + 1
		const dot = tokens[index + 1]
		const target = tokens[index + 2]
		if (token.text !== '"public"' || dot?.text !== '.' || !target) continue
		const name = identifier(target)
		if (!name) continue
		const before = tokens[index - 1]?.text
		const foreignKey = before === 'REFERENCES' && tables.has(name)
		if (foreignKey && explicitTables.has(name)) {
			throw new Error(
				`[database] ambiguous generated foreign key target public.${name}: both owner and explicit public tables exist`,
			)
		}
		// During enum replacement Kit casts both the column and its default.
		const enumCast =
			before === '::' && generatedColumnCast(tokens, statement, tokens[index - 1]!, bytes, current)
		const enumType = (before === 'TYPE' || enumCast) && enums.has(name)
		if (!foreignKey && !enumType && !(before === 'SEQUENCE' && sequences.has(name))) continue
		// libpg_query reports byte offsets. Keep every other byte, including comments.
		result.push(bytes.subarray(start, token.start), bytes.subarray(token.end, dot.start))
		start = dot.end
	}
	if (result.length === 0) return source
	result.push(bytes.subarray(start))
	return Buffer.concat(result).toString()
}
