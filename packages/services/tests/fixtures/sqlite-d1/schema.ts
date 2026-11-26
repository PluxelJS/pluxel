import { defineDatabase } from '@pluxel/services/sqlite'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const items = sqliteTable('items', { id: text('id').primaryKey() })
export const database = defineDatabase({ schema: { items } })
