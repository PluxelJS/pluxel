import {
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { MarketMetadata, Provenance } from './protocol'

export const packages = sqliteTable(
	'packages',
	{
		registry: text('registry').notNull().default('https://registry.npmjs.org'),
		name: text('name').notNull(),
		description: text('description'),
		repository: text('repository'),
		repositoryStars: integer('repository_stars'),
		repositoryObservedAt: integer('repository_observed_at'),
		metadataVersion: text('metadata_version'),
		readme: text('readme', { mode: 'json' }).$type<{ text: string; truncated: boolean } | null>(),
		license: text('license'),
		distTags: text('dist_tags', { mode: 'json' }).$type<Record<string, string>>().notNull(),
		observedAt: integer('observed_at').notNull(),
		// Human visibility and its revision are never overwritten by npm refreshes.
		hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
		revision: integer('revision').notNull().default(1),
		official: integer('official', { mode: 'boolean' }).notNull().default(false),
		category: text('category'),
		tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
	},
	(table) => [
		primaryKey({ columns: [table.registry, table.name] }),
		index('package_browse').on(table.hidden, table.name, table.registry),
		index('package_category').on(table.category, table.official),
	],
)

export const releases = sqliteTable(
	'releases',
	{
		registry: text('registry').notNull().default('https://registry.npmjs.org'),
		name: text('name').notNull(),
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
		readme: text('readme', { mode: 'json' }).$type<{ text: string; truncated: boolean } | null>(),
		license: text('license'),
	},
	(table) => [
		primaryKey({ columns: [table.registry, table.name, table.version] }),
		foreignKey({
			columns: [table.registry, table.name],
			foreignColumns: [packages.registry, packages.name],
		}),
	],
)

export const notifications = sqliteTable(
	'notifications',
	{
		id: text('id').primaryKey(),
		registry: text('registry').notNull().default('https://registry.npmjs.org'),
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
		uniqueIndex('notification_coordinate').on(table.registry, table.name, table.version),
		index('notification_schedule').on(table.status, table.nextAttemptAt),
		index('notification_retention').on(table.updatedAt),
	],
)

export const audits = sqliteTable(
	'audits',
	{
		id: text('id').primaryKey(),
		registry: text('registry').notNull().default('https://registry.npmjs.org'),
		name: text('name').notNull(),
		action: text('action').notNull(),
		revision: integer('revision'),
		changes: text('changes', { mode: 'json' }).$type<MarketMetadata | { hidden: boolean }>(),
		at: integer('at').notNull(),
	},
	(table) => [index('audit_package').on(table.registry, table.name, table.at)],
)
