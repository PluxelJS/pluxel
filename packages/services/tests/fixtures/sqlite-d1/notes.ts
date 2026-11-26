import { BasePlugin, Plugin } from '@pluxel/core'
import { Sqlite } from '@pluxel/services/sqlite'
import { database, items } from './schema'

@Plugin({ forkable: true })
export class Notes extends BasePlugin {
	async supportsInteractiveTransactions() {
		const handle = await this.ctx.service(Sqlite).use(database)
		return handle.supportsInteractiveTransactions
	}

	async visit(path: string) {
		const handle = await this.ctx.service(Sqlite).use(database)
		return handle.run(async (db) => {
			if (path === '/fail') {
				await db.batch([
					db.insert(items).values({ id: 'rolled-back' }),
					db.insert(items).values({ id: 'seed' }),
				])
			} else if (path === '/write') {
				await db.batch([db.insert(items).values({ id: 'a' }), db.insert(items).values({ id: 'b' })])
			}
			return db.query.items.findMany({ orderBy: items.id })
		})
	}
}
