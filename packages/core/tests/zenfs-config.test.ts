import {
	CopyOnWrite,
	InMemory,
	type Backend,
	type FileSystem,
	type MountConfiguration,
} from '@zenfs/core'
import { expect, it } from 'vitest'
import { zenfs } from '../src/config/zenfs'
import { writeFileAtomic } from '../src/fs'
import { createCoreTestHost, getCoreTestHostContext } from '../src/internal-test'
import { requireFs } from '../src/internal/storage'

it('snapshots native declarations without preparing backends or copying opaque resources', async () => {
	let creates = 0
	let checks = 0
	let readies = 0
	const channel = { state: 'borrowed' }
	const backend = {
		name: 'ApplicationBackend',
		options: {
			label: {
				type: () => {
					checks++
					return true
				},
				required: true,
			},
			channel: { type: 'object', required: true },
			child: { type: 'object', required: false },
		},
		isAvailable() {
			checks++
			return true
		},
		create(options: { label: string; channel: object; child?: MountConfiguration<Backend> }) {
			creates++
			return InMemory.create({ label: options.label })
		},
	} satisfies Backend<
		FileSystem,
		{ label: string; channel: object; child?: MountConfiguration<Backend> }
	>
	const borrowed = InMemory.create({})
	const ready = borrowed.ready.bind(borrowed)
	borrowed.ready = async () => {
		readies++
		await ready()
	}
	try {
		const child = { backend, label: 'child', channel }
		const mount = { backend, label: 'parent', channel, child }
		const input = { mounts: { 'data/': mount, '/borrowed': borrowed }, durableMounts: ['data/'] }
		const snapshot = zenfs(input)
		expect({ creates, checks, readies }).toEqual({ creates: 0, checks: 0, readies: 0 })
		expect(snapshot).not.toBe(input)
		expect(Object.keys(snapshot.mounts)).toEqual(['/data', '/borrowed', '/'])
		expect(snapshot.mounts['/']).toBe(InMemory)
		expect(snapshot.mounts['/borrowed']).toBe(borrowed)
		expect(snapshot.mounts['/data']).not.toBe(mount)
		expect(Reflect.get(snapshot.mounts['/data']!, 'backend')).toBe(backend)
		expect(Reflect.get(snapshot.mounts['/data']!, 'channel')).toBe(channel)
		const copiedChild = Reflect.get(snapshot.mounts['/data']!, 'child')
		expect(copiedChild).not.toBe(child)
		expect(Object.isFrozen(copiedChild)).toBe(true)
		expect(Reflect.get(copiedChild, 'backend')).toBe(backend)
		expect(Reflect.get(copiedChild, 'channel')).toBe(channel)
		expect(
			[snapshot, snapshot.mounts, snapshot.mounts['/data'], snapshot.durableMounts].every(
				Object.isFrozen,
			),
		).toBe(true)
		expect([backend, borrowed, channel].some(Object.isFrozen)).toBe(false)
		mount.label = 'changed parent'
		child.label = 'changed child'
		input.durableMounts.splice(0)
		expect(snapshot.mounts['/data']).toMatchObject({ label: 'parent', child: { label: 'child' } })
		expect(snapshot.durableMounts).toEqual(['/data'])
		expect(input.mounts['data/']).toBe(mount)
	} finally {
		await borrowed.close()
	}
})

it.each([null, false, 42, 'storage', []])(
	'rejects explicit malformed storage input: %j',
	(input) => {
		expect(() => Reflect.apply(zenfs, undefined, [input])).toThrow(TypeError)
	},
)

it('applies omitted defaults and rejects invalid declarations before Core construction', () => {
	const snapshot = zenfs()
	expect(snapshot.mounts['/']).toBe(InMemory)
	expect(snapshot.durableMounts).toEqual([])
	expect(() => zenfs({ mounts: { data: InMemory, '/data': InMemory } })).toThrow(
		'duplicate mount point',
	)
	expect(() => zenfs({ mounts: { '/': InMemory }, durableMounts: ['/undeclared'] })).toThrow(
		'undeclared mount',
	)
})

it('feeds a captured native composition and borrowed mount into Core without changing ownership', async () => {
	const borrowed = InMemory.create({})
	const close = borrowed.close.bind(borrowed)
	let closes = 0
	borrowed.close = async () => {
		closes++
		await close()
	}
	try {
		const composition = { backend: CopyOnWrite, readable: InMemory, writable: InMemory }
		const input = { mounts: { '/': composition, '/borrowed': borrowed } }
		const storage = zenfs(input)
		const unavailable = { ...InMemory, isAvailable: () => false }
		composition.writable = unavailable
		const host = createCoreTestHost({ storage })
		try {
			const fs = requireFs(getCoreTestHostContext(host))
			const composed = await fs.directory('composed')
			await writeFileAtomic(composed, 'record', 'COMPOSED')
			expect(await composed.readFile('record', 'utf8')).toBe('COMPOSED')
			const files = await fs.directory('borrowed/files')
			await writeFileAtomic(files, 'record', 'BORROWED')
			expect(await files.readFile('record', 'utf8')).toBe('BORROWED')
		} finally {
			await host.dispose()
		}
		expect(closes).toBe(0)
	} finally {
		await borrowed.close()
	}
	expect(closes).toBe(1)
})
