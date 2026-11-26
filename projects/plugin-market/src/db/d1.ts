import { drizzle } from 'drizzle-orm/d1'

export function connect(binding: D1Database) {
	return drizzle(binding)
}

export type Database = ReturnType<typeof connect>
