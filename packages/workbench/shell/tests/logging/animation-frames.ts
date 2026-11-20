import { act } from 'react'
import { vi } from 'vitest'

export function installAnimationFrames() {
	const frames = new Map<number, FrameRequestCallback>()
	let nextId = 0
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.set(++nextId, callback)
		return nextId
	})
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))

	return {
		get pending() {
			return frames.size
		},
		flush: () =>
			act(async () => {
				const current = [...frames.values()]
				frames.clear()
				for (const frame of current) frame(0)
			}),
	}
}
