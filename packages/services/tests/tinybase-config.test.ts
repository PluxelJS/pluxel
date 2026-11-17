import * as nativeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { Passthrough } from '@pluxel/core/fs'
import { requireHostDocuments } from '@pluxel/core/internal'

let normalizations = 0
const Config = v.object({
	text: v.optional(
		v.pipe(
			v.string(),
			v.transform((value) => {
				normalizations++
				return value.trim()
			}),
		),
		'default',
	),
	locked: v.optional(v.string(), 'base'),
})
let applied: v.InferOutput<typeof Config> | undefined
@Plugin()
class ConfiguredOwner extends BasePlugin {
	readonly config = this.configs.use(Config)
	protected override init(): void {
		applied = this.config
	}
}

it('keeps saved input sparse and normalizes once across durable Hosts', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-tinybase-config-'))
	const owner = ConfiguredOwner.nodeAddress()
	const runtime = {
		zenfs: {
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
			durableMounts: ['/'],
		},
	}
	try {
		const host = await createHost({
			plugins: [ConfiguredOwner],
			runtime,
			config: {
				mode: 'saved-first',
				records: [{ owner, config: { text: 'initial', locked: 'declared' } }],
			},
			policy: { autoStart: [owner] },
		})
		try {
			await host.start()
			const before = normalizations
			const result = await host.config.patch(owner, { set: { text: ' saved ' } })
			expect(result).toMatchObject({
				ok: true,
				persistence: { status: 'confirmed', retention: 'declared-durable' },
				application: 'saved-not-applied',
				applyFailure: { code: 'listener_not_registered' },
			})
			expect(normalizations).toBe(before + 1)
			const persisted = await requireHostDocuments(host.ctx, 'config').getText('config.json')
			expect(JSON.parse(persisted!)).toMatchObject({
				json: { version: 4, plugins: [{ owner, config: { text: ' saved ' } }] },
			})
		} finally {
			await host.close()
		}
		const reopened = await createHost({
			plugins: [ConfiguredOwner],
			runtime,
			config: {
				mode: 'saved-first',
				records: [{ owner, config: { text: 'different base', locked: 'declared' } }],
			},
			policy: { autoStart: [owner] },
		})
		try {
			await reopened.start()
			const before = normalizations
			await expect(reopened.config.get(owner)).resolves.toMatchObject({
				ok: true,
				application: 'applied',
				managedInput: { text: ' saved ' },
				config: { text: 'saved', locked: 'declared' },
			})
			expect(normalizations).toBe(before)
			expect(applied).toEqual({ text: 'saved', locked: 'declared' })
			await expect(reopened.config.reset(owner, [['text']])).resolves.toMatchObject({
				ok: true,
				managedInput: {},
				effectiveInput: { text: 'different base', locked: 'declared' },
				persistence: { status: 'confirmed' },
			})
		} finally {
			await reopened.close()
		}
	} finally {
		await rm(prefix, { recursive: true, force: true })
	}
})
