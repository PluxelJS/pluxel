import { beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
	readPreferences,
	resetPreferences,
	setPreference,
	watchPreferences,
} from '../src/preferences'

beforeEach(() => fakeBrowser.reset())

it('uses per-rule defaults and resets only the extension rules', async () => {
	await fakeBrowser.storage.local.set({ unrelated: 123, fragment: true })
	expect(await readPreferences()).toEqual({ tracking: true, fragment: true })
	await setPreference('tracking', false)
	expect(await readPreferences()).toEqual({ tracking: false, fragment: true })
	await resetPreferences()
	expect(await fakeBrowser.storage.local.get()).toEqual({ unrelated: 123 })
	expect(await readPreferences()).toEqual({ tracking: true, fragment: false })
})

it.each([0, 'false'])(
	'reports an invalid stored choice (%j) until explicitly reset',
	async (value) => {
		await fakeBrowser.storage.local.set({ tracking: value })
		await expect(readPreferences()).rejects.toThrow('tracking')
		expect(await fakeBrowser.storage.local.get('tracking')).toEqual({ tracking: value })
		await resetPreferences()
		const preferences = await readPreferences()
		expect(preferences.tracking).toBe(true)
	},
)

it('observes rule writes from another extension page until disposed', async () => {
	const refresh = vi.fn()
	const unwatch = watchPreferences(refresh)
	try {
		await fakeBrowser.storage.local.set({ unrelated: true })
		expect(refresh).not.toHaveBeenCalled()
		await fakeBrowser.storage.local.set({ fragment: true })
		expect(refresh).toHaveBeenCalledTimes(1)
	} finally {
		unwatch()
	}
	await setPreference('fragment', false)
	expect(refresh).toHaveBeenCalledTimes(1)
})
