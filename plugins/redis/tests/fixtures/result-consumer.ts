import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { Redis } from '../../src/index.ts'

export class DraftNotFound extends TaggedError('DraftNotFound')<{ id: string }> {}

@Plugin()
export class DraftsPlugin extends BasePlugin {
	constructor(private readonly redis: Redis) {
		super()
	}

	async read(id: string): Promise<Result<string, DraftNotFound>> {
		const text = await this.redis.connection().client.get(`drafts:${id}`)
		if (text === null) return Result.err(new DraftNotFound({ id }))
		if (typeof text !== 'string') throw new TypeError('Expected UTF-8 draft text from Redis')
		return Result.ok(text)
	}
}
