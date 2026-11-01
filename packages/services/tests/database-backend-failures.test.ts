import { PGlite } from '@electric-sql/pglite'
import { pglite } from '@pluxel/services/database/pglite'
import { postgres } from '@pluxel/services/database/postgres'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const construction = vi.hoisted(() => ({ postgres: vi.fn(), pglite: vi.fn() }))
vi.mock('drizzle-orm/node-postgres', async (importOriginal) => {
	const native = await importOriginal<typeof import('drizzle-orm/node-postgres')>()
	return {
		...native,
		drizzle(...parameters: Parameters<typeof native.drizzle>) {
			construction.postgres()
			return Reflect.apply(native.drizzle, undefined, parameters)
		},
	}
})
vi.mock('drizzle-orm/pglite', async (importOriginal) => {
	const native = await importOriginal<typeof import('drizzle-orm/pglite')>()
	return {
		...native,
		drizzle(...parameters: Parameters<typeof native.drizzle>) {
			construction.pglite(...parameters)
			return Reflect.apply(native.drizzle, undefined, parameters)
		},
	}
})

beforeEach(() => {
	construction.postgres.mockReset()
	construction.pglite.mockReset()
})
afterEach(() => vi.restoreAllMocks())

// Acquisition includes cold native driver imports and PGlite WASM initialization.
describe('database backend acquisition failure', { timeout: 30_000 }, () => {
	it('ends an owned pg pool and detaches its listener when Drizzle construction fails', async () => {
		const failure = new Error('Drizzle construction failed')
		construction.postgres.mockImplementationOnce(() => {
			throw failure
		})
		const end = vi.spyOn(Pool.prototype, 'end')
		await expect(postgres()(vi.fn())).rejects.toBe(failure)
		expect(end).toHaveBeenCalledOnce()
		const pool = end.mock.instances[0] as Pool
		expect(pool.ended).toBe(true)
		expect(pool.listenerCount('error')).toBe(0)
	})

	it('preserves the primary pg setup failure and a failed pool cleanup', async () => {
		const failure = new Error('Drizzle construction failed')
		const cleanupError = new Error('pool cleanup failed')
		construction.postgres.mockImplementationOnce(() => {
			throw failure
		})
		const end = vi
			.spyOn(Pool.prototype, 'end')
			.mockImplementationOnce(() => Promise.reject(cleanupError))
		try {
			await expect(postgres()(vi.fn())).rejects.toMatchObject({
				cause: failure,
				errors: [failure, cleanupError],
			})
			expect((end.mock.instances[0] as Pool).listenerCount('error')).toBe(0)
		} finally {
			const pool = end.mock.instances[0] as Pool | undefined
			end.mockRestore()
			await pool?.end()
		}
	})

	it('leaves a borrowed pg pool open and retains application listeners on setup failure', async () => {
		const pool = new Pool()
		const applicationError = vi.fn()
		pool.on('error', applicationError)
		const failure = new Error('Drizzle construction failed')
		construction.postgres.mockImplementationOnce(() => {
			throw failure
		})
		try {
			await expect(postgres(pool)(vi.fn())).rejects.toBe(failure)
			expect(pool.ending).toBe(false)
			expect(pool.listeners('error')).toEqual([applicationError])
		} finally {
			await pool.end()
		}
	})

	it('attempts owned PGlite cleanup after a real native initialization rejection', async () => {
		const failure = new Error('native extension initialization failed')
		const close = vi.spyOn(PGlite.prototype, 'close')
		const backend = pglite({
			extensions: {
				failure: {
					name: 'failing-extension',
					setup: async () => {
						throw failure
					},
				},
			},
		})
		await expect(backend(vi.fn())).rejects.toMatchObject({
			cause: failure,
			errors: [expect.objectContaining({ cause: failure }), failure],
		})
		expect(close).toHaveBeenCalledOnce()
		expect(construction.pglite).not.toHaveBeenCalled()
	})

	it('closes its initialized PGlite client if Drizzle construction fails', async () => {
		const failure = new Error('Drizzle construction failed')
		let client: PGlite | undefined
		construction.pglite.mockImplementationOnce((options: { client: PGlite }) => {
			client = options.client
			throw failure
		})
		const close = vi.spyOn(PGlite.prototype, 'close')
		await expect(pglite()(vi.fn())).rejects.toMatchObject({ cause: failure })
		expect(close.mock.contexts.filter((context) => context === client)).toHaveLength(1)
		expect(client?.closed).toBe(true)
	})

	it('does not close a borrowed PGlite client if Drizzle construction fails', async () => {
		const client = await PGlite.create()
		const close = vi.spyOn(client, 'close')
		const failure = new Error('Drizzle construction failed')
		construction.pglite.mockImplementationOnce(() => {
			throw failure
		})
		try {
			await expect(pglite(client)(vi.fn())).rejects.toMatchObject({ cause: failure })
			expect(close).not.toHaveBeenCalled()
			expect(await client.query('select 1 as answer')).toMatchObject({ rows: [{ answer: 1 }] })
		} finally {
			await client.close()
		}
	})
})
