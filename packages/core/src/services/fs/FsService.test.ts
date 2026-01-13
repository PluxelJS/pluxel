import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

function randomHex(bytes: number): string {
	const c = (
		globalThis as unknown as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
	).crypto
	if (typeof c?.getRandomValues === 'function') {
		const buf = new Uint8Array(bytes)
		c.getRandomValues(buf)
		return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
	}
	return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
}

describe('FsService', () => {
	it('supports memory backend and readBytes() returns a copy', async () => {
		const dir = `/fs/${randomHex(6)}`
		const path = `${dir}/a.txt`

		await withTestHost(
			async (host) => {
				@Plugin({ name: 'P' })
				class P extends BasePlugin {}

				await host.start(P)

				const before = host.ctx.fs.debugStats()
				await host.ctx.fs.writeTextAtomic(path, 'hello')
				const after = host.ctx.fs.debugStats()
				expect(after.writeTextAtomic - before.writeTextAtomic).toBe(1)

				expect(host.ctx.fs.debugListFiles(dir)).toEqual([path])

				const bytes1 = await host.ctx.fs.readBytes(path)
				const orig0 = bytes1[0]
				bytes1[0] = (orig0 ^ 0xff) & 0xff
				const bytes2 = await host.ctx.fs.readBytes(path)
				expect(bytes2[0]).toBe(orig0)
			},
			{ fs: { mode: 'memory' } },
		)
	})
})

