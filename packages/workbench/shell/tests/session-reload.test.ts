import { describe, expect, it } from 'vitest'
import {
	clearSessionReloadHistory,
	reserveSessionReload,
	sessionReloadDecision,
	sessionReloadDelay,
	installSessionEntryHmrBoundary,
} from '../src/sessionReload'

function storage() {
	const items = new Map<string, string>()
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			items.set(key, value)
		},
		removeItem: (key: string) => {
			items.delete(key)
		},
	}
}

describe('session replacement reloads', () => {
	it('ends entry module HMR before a second bootstrap can execute while allowing ordinary component updates', async () => {
		let receive!: (event: { updates: { path: string; acceptedPath: string }[] }) => Promise<void>
		const steps: string[] = []
		installSessionEntryHmrBoundary({
			hot: {
				on: (_event: string, listener: typeof receive) => {
					receive = listener
				},
			} as unknown as Parameters<typeof installSessionEntryHmrBoundary>[0]['hot'],
			entryUrl: 'http://localhost:5173/@fs/workbench/client.tsx?t=1',
			dispose: () => {
				steps.push('dispose')
			},
			reload: () => {
				steps.push('reload')
			},
		})
		await receive({
			updates: [{ path: '/@fs/workbench/Status.tsx', acceptedPath: '/@fs/workbench/Status.tsx' }],
		})
		expect(steps).toEqual([])
		let replacementCanExecute = false
		void receive({
			updates: [{ path: '/@fs/workbench/client.tsx', acceptedPath: '/@fs/workbench/client.tsx' }],
		}).then((): void => {
			replacementCanExecute = true
			return undefined
		})
		await Promise.resolve()
		expect(steps).toEqual(['dispose', 'reload'])
		expect(replacementCanExecute).toBe(false)
	})
	it('automatically reloads publication changes and service restarts but leaves authentication explicit', () => {
		const history = storage()
		expect(sessionReloadDecision('workbench', history)).toBe('automatic')
		expect(sessionReloadDecision('service-restart', history)).toBe('automatic')
		expect(sessionReloadDecision('authentication', history)).toBe('authentication')
	})

	it('bounds reloads across documents without blocking later independent edits', () => {
		const history = storage()
		for (let index = 0; index < 3; index++) {
			expect(sessionReloadDelay(history, 1000 + index * 1000)).toBe(750 * 2 ** index)
			expect(reserveSessionReload(history, 1000 + index * 1000)).toBe(true)
		}
		expect(sessionReloadDecision('workbench', history, 4000)).toBe('frequent')
		expect(reserveSessionReload(history, 4000)).toBe(false)
		expect(sessionReloadDecision('workbench', history, 11000)).toBe('automatic')
		expect(reserveSessionReload(history, 11000)).toBe(true)
	})

	it('does not consume a reload budget while inspecting or mounting twice in StrictMode', () => {
		const history = storage()
		for (let index = 0; index < 10; index++) {
			expect(sessionReloadDecision('workbench', history, 1000)).toBe('automatic')
		}
		expect(reserveSessionReload(history, 1000)).toBe(true)
		expect(sessionReloadDecision('workbench', history, 1000)).toBe('automatic')
	})

	it('allows deliberate manual recovery and fails closed when cross-document storage is unavailable', () => {
		const history = storage()
		for (let index = 0; index < 3; index++) reserveSessionReload(history, 1000)
		clearSessionReloadHistory(history)
		expect(sessionReloadDecision('workbench', history, 1000)).toBe('automatic')
		const unavailable = {
			getItem: () => {
				throw new Error('blocked')
			},
			setItem: () => {
				throw new Error('blocked')
			},
		}
		expect(sessionReloadDecision('workbench', unavailable)).toBe('unavailable')
		expect(reserveSessionReload(unavailable)).toBe(false)
	})
})
