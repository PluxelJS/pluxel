import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Experimental records only: this is not the marketplace's release schema.
export const registrations = sqliteTable('registrations', {
	id: text('id').primaryKey(),
	label: text('label').notNull(),
	revision: integer('revision').notNull().default(1),
})

export const edits = sqliteTable('edits', {
	id: text('id').primaryKey(),
	recordId: text('record_id')
		.notNull()
		.references(() => registrations.id),
	revision: integer('revision').notNull(),
	actor: text('actor').notNull(),
})

export const notifications = sqliteTable(
	'notifications',
	{
		id: text('id').primaryKey(),
		registry: text('registry').notNull(),
		packageName: text('package_name').notNull(),
		version: text('version').notNull(),
		status: text('status', { enum: ['pending', 'processing', 'failed'] })
			.notNull()
			.default('pending'),
		attempt: integer('attempt').notNull().default(0),
		leaseToken: text('lease_token'),
		leaseUntil: integer('lease_until'),
		diagnostic: text('diagnostic'),
	},
	(table) => [
		uniqueIndex('notification_coordinate').on(table.registry, table.packageName, table.version),
	],
)
