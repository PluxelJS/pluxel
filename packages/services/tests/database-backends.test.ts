import { PGlite, type Extension, types } from '@electric-sql/pglite'
import { pglite } from '@pluxel/services/database/pglite'
import { postgres } from '@pluxel/services/database/postgres'
import { sql } from 'drizzle-orm'
import { Pool, type PoolConfig } from 'pg'
import { describe, expect, it, vi } from 'vitest'

describe('native database backends', () => {
	it('preserves native pg connection, TLS, parser and pool options without opening a connection', async () => {
		const password = async () => 'rotating-password'
		const ssl = { ca: 'application-ca', rejectUnauthorized: true }
		const getTypeParser = vi.fn(() => (value: string) => value)
		const config: PoolConfig = {
			host: '/var/run/postgresql',
			port: 5433,
			user: 'application',
			database: 'example',
			password,
			ssl,
			types: { getTypeParser },
			keepAlive: true,
			application_name: 'pluxel-native-config',
			max: 3,
			min: 1,
			idleTimeoutMillis: 321,
			connectionTimeoutMillis: 456,
			maxLifetimeSeconds: 90,
			allowExitOnIdle: true,
		}
		const adapter = await postgres(config)(vi.fn())
		const pool = Reflect.get(adapter.db, '$client') as Pool
		try {
			expect(pool).toBeInstanceOf(Pool)
			expect(pool.options).toMatchObject(config)
			expect(pool.options.password).toBe(password)
			expect(pool.options.ssl).toBe(ssl)
			expect(pool.options.types?.getTypeParser).toBe(getTypeParser)
			expect(pool.totalCount).toBe(0)
			expect(adapter.concurrency).toBe(3)
		} finally {
			await adapter.close()
		}
		expect(pool.ended).toBe(true)
		expect(pool.listenerCount('error')).toBe(0)
	})

	it('retains native pg defaults when the application uses PG environment configuration', async () => {
		const adapter = await postgres()(vi.fn())
		try {
			const pool = Reflect.get(adapter.db, '$client') as Pool
			expect(adapter.concurrency).toBe(pool.options.max)
			expect(pool.totalCount).toBe(0)
		} finally {
			await adapter.close()
		}
	})

	it('borrows an existing pg Pool and removes only the retiring adapter error listener', async () => {
		const pool = new Pool({ max: 2 })
		const end = vi.spyOn(pool, 'end')
		const applicationError = vi.fn()
		pool.on('error', applicationError)
		const firstError = vi.fn()
		const secondError = vi.fn()
		const first = await postgres(pool)(firstError)
		const second = await postgres(pool)(secondError)
		try {
			expect(Reflect.get(first.db, '$client')).toBe(pool)
			expect(first.concurrency).toBe(2)
			await first.close()
			const error = new Error('idle connection lost')
			pool.emit('error', error)
			expect(applicationError).toHaveBeenCalledWith(error)
			expect(firstError).not.toHaveBeenCalled()
			expect(secondError).toHaveBeenCalledWith(error)
			await second.close()
			expect(pool.listeners('error')).toEqual([applicationError])
			expect(end).not.toHaveBeenCalled()
			expect(pool.ending).toBe(false)
		} finally {
			await first.close()
			await second.close()
			await pool.end()
		}
	})

	it('borrows a native pool from another pg constructor binding', async () => {
		// pg exports a BoundPool subclass; another pg installation has its own binding.
		const NativePool = Object.getPrototypeOf(Pool) as typeof Pool
		const pool = new NativePool({ max: 2 })
		try {
			expect(pool).not.toBeInstanceOf(Pool)
			const adapter = await postgres(pool)(vi.fn())
			expect(Reflect.get(adapter.db, '$client')).toBe(pool)
			expect(adapter.concurrency).toBe(2)
			await adapter.close()
			expect(pool.ending).toBe(false)
		} finally {
			await pool.end()
		}
	})

	it('uses native PGlite extensions and result parsers and closes its owned client', async () => {
		const extensionClose = vi.fn(async () => {})
		const setup = vi.fn<Extension['setup']>(async () => ({
			namespaceObj: { native: true },
			close: extensionClose,
		}))
		const backend = pglite({
			extensions: { schema: { name: 'native-options', setup } },
			parsers: { [types.INT4]: (value: string) => Number(value) + 1 },
		})
		expect(setup).not.toHaveBeenCalled()
		const adapter = await backend(vi.fn())
		const client = Reflect.get(adapter.db, '$client') as PGlite
		try {
			expect(adapter.concurrency).toBe(1)
			expect(setup).toHaveBeenCalledOnce()
			expect(Reflect.get(client, 'schema')).toEqual({ native: true })
			expect(await adapter.db.execute(sql`select 41::int4 as answer`)).toMatchObject({
				rows: [{ answer: 42 }],
			})
		} finally {
			await adapter.close()
		}
		expect(client.closed).toBe(true)
		expect(extensionClose).toHaveBeenCalledOnce()
	}, 30_000)

	it('borrows a native PGlite instance without closing it', async () => {
		const client = await PGlite.create()
		try {
			const adapter = await pglite(client)(vi.fn())
			expect(Reflect.get(adapter.db, '$client')).toBe(client)
			await adapter.close()
			expect(client.closed).toBe(false)
			expect(await client.query('select 1 as answer')).toMatchObject({ rows: [{ answer: 1 }] })
		} finally {
			await client.close()
		}
	}, 30_000)

	it.each([null, false, 12, 'memory://', []])('rejects invalid explicit input %j', (input) => {
		expect(() => Reflect.apply(postgres, undefined, [input])).toThrow(TypeError)
		expect(() => Reflect.apply(pglite, undefined, [input])).toThrow(TypeError)
	})

	it.each([0, -1, 1.5, Number.NaN])(
		'rejects pg max %s before it can stall fair scheduling',
		(max) => {
			expect(() => postgres({ max })).toThrow('pg max must be a positive integer')
		},
	)
})
