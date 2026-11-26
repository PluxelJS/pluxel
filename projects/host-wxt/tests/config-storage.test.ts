import { beforeEach, expect, it } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { createConfigStorage } from '../src/config-storage'

beforeEach(() => fakeBrowser.reset())

it('only one page can replace the same document revision', async () => {
	const first = createConfigStorage()
	const second = createConfigStorage()
	const file = 'config.json'
	await Promise.all([first.getText(file), second.getText(file)])
	const writes = await Promise.allSettled([first.put(file, 'first'), second.put(file, 'second')])
	expect(writes.filter((write) => write.status === 'fulfilled')).toHaveLength(1)
	expect(writes.filter((write) => write.status === 'rejected')).toHaveLength(1)
	const winner = writes[0]?.status === 'fulfilled' ? 'first' : 'second'
	expect(await second.getText(file)).toBe(winner)
	await second.put(file, 'updated')
	expect(await first.getText(file)).toBe('updated')
})
