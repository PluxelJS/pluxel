import { BasePlugin, ForkablePlugin, getPluginInfo, Plugin, withHost } from '@pluxel/test'
import { v } from '@pluxel/runtime'
import { describe, expect, it } from 'vitest'
import { S3, type S3Client, S3Config, S3NotRunningError } from '../src/index.ts'

@Plugin(S3, { name: 'MemoryS3Plugin' })
class MemoryS3Plugin extends S3 {
	private readonly holder: { client?: S3Client } = {}

	override get client(): S3Client {
		const client = this.holder.client
		if (!client) throw new S3NotRunningError()
		return client
	}

	protected override init(): void {
		const client = { provider: 'memory' } as unknown as S3Client
		this.holder.client = client
		this.ctx.effects.defer(() => {
			if (this.holder.client === client) this.holder.client = undefined
		})
	}
}

@Plugin({ name: 'S3ConsumerA' })
class S3ConsumerA extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

@Plugin({ name: 'S3ConsumerB' })
class S3ConsumerB extends BasePlugin {
	constructor(readonly s3: S3) {
		super()
	}
}

describe('S3 capability', () => {
	it('uses one discriminated config contract and defaults to local storage', () => {
		expect(v.parse(S3Config, {})).toEqual({
			backend: {
				type: 'local',
				rootDir: '.pluxel/s3',
				bucketName: 'local',
				syncWrites: true,
			},
		})
		expect(
			v.safeParse(S3Config, {
				backend: { type: 'remote', endpoint: 'https://bucket.example.com' },
			}).success,
		).toBe(false)
	})

	it('is a forkable polymorphic token exposing one raw S3 client', async () => {
		expect(getPluginInfo(MemoryS3Plugin).base).toBe(S3)
		expect(S3.prototype).toBeInstanceOf(ForkablePlugin)

		await withHost(async (host) => {
			host.add([MemoryS3Plugin, S3ConsumerA, S3ConsumerB])
			await host.commit()
			const a = host.require(S3ConsumerA).s3
			const b = host.require(S3ConsumerB).s3
			expect(a.client).toBe(b.client)

			host.remove(MemoryS3Plugin)
			await host.commit()
			expect(() => a.client).toThrow(S3NotRunningError)
		})
	})
})
