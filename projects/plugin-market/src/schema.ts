import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { Provenance } from './protocol'

export const packages = sqliteTable('packages', {
	name: text('name').primaryKey(),
	description: text('description'),
	distTags: text('dist_tags', { mode: 'json' }).$type<Record<string, string>>().notNull(),
	observedAt: integer('observed_at').notNull(),
	// Human visibility and its revision are never overwritten by npm refreshes.
	hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
	revision: integer('revision').notNull().default(1),
})

export const releases = sqliteTable(
	'releases',
	{
		name: text('name')
			.notNull()
			.references(() => packages.name),
		version: text('version').notNull(),
		tarball: text('tarball').notNull(),
		integrity: text('integrity').notNull(),
		checkedAt: integer('checked_at').notNull(),
		provenance: text('provenance', { mode: 'json' }).$type<Provenance>().notNull(),
		peerDependencies: text('peer_dependencies', { mode: 'json' })
			.$type<Record<string, string>>()
			.notNull(),
		pluginPackages: text('plugin_packages', { mode: 'json' })
			.$type<Record<string, 'required' | 'optional'>>()
			.notNull(),
	},
	(table) => [primaryKey({ columns: [table.name, table.version] })],
)

export const notifications = sqliteTable(
	'notifications',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		version: text('version').notNull(),
		status: text('status', { enum: ['pending', 'processing', 'indexed', 'failed'] })
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		nextAttemptAt: integer('next_attempt_at'),
		leaseToken: text('lease_token'),
		leaseUntil: integer('lease_until'),
		code: text('code'),
		diagnostic: text('diagnostic'),
	},
	(table) => [
		uniqueIndex('notification_coordinate').on(table.name, table.version),
		index('notification_schedule').on(table.status, table.nextAttemptAt),
		index('notification_retention').on(table.updatedAt),
	],
)

export const audits = sqliteTable(
	'audits',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		action: text('action').notNull(),
		revision: integer('revision'),
		at: integer('at').notNull(),
	},
	(table) => [index('audit_package').on(table.name, table.at)],
)
