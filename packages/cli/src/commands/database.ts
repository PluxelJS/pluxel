import { type ArgValues, define } from 'gunshi'
import {
	databaseCheckDefinition,
	databaseCommandDefinition,
	databaseCommonArgs,
	databaseGenerateArgs,
	databaseGenerateDefinition,
	databaseRebaseArgs,
	databaseRebaseDefinition,
} from '../command-manifest'

type DatabaseCommonValues = ArgValues<typeof databaseCommonArgs>
type DatabaseGenerateValues = ArgValues<typeof databaseGenerateArgs>
type DatabaseRebaseValues = ArgValues<typeof databaseRebaseArgs>

export const databaseGenerateCommand = define({
	...databaseGenerateDefinition,
	async run(ctx) {
		const values = ctx.values as DatabaseGenerateValues
		const database = await import('@pluxel/rolldown/database')
		await database.generateDatabaseMigrations(values)
		ctx.log('[database] migrations generated and checksummed')
	},
})

export const databaseCheckCommand = define({
	...databaseCheckDefinition,
	async run(ctx) {
		const values = ctx.values as DatabaseCommonValues
		const database = await import('@pluxel/rolldown/database')
		await database.checkDatabaseMigrations(values)
		ctx.log('[database] migration history and schema are valid')
	},
})

export const databaseRebaseCommand = define({
	...databaseRebaseDefinition,
	async run(ctx) {
		const values = ctx.values as DatabaseRebaseValues
		if (!values.lineage) throw new Error('[database] rebase requires --lineage <id>')
		const database = await import('@pluxel/rolldown/database')
		await database.rebaseDatabaseMigrations({ ...values, lineage: values.lineage })
		ctx.log(`[database] migration history rebased to lineage ${values.lineage}`)
	},
})

export const databaseCommand = define({
	...databaseCommandDefinition,
	async run() {},
})
