import type { HostDocumentStorage } from '@pluxel/host/embedded'
import { browser } from 'wxt/browser'

const prefix = 'pluxel.config/'
const configChanges = new EventTarget()
export function watchConfig(listener: () => void) {
	configChanges.addEventListener('change', listener)
	return () => configChanges.removeEventListener('change', listener)
}

// Each Host owns its read baseline. An editor must never overwrite another page's newer document.
export function createConfigStorage(): HostDocumentStorage {
	const seen = new Map<string, string | undefined>()
	async function read(key: string) {
		const record = await browser.storage.local.get(key)
		const value = record[key]
		if (value !== undefined && typeof value !== 'string')
			throw new TypeError(`配置文档 ${key} 必须是文本`)
		return value
	}
	return {
		async getText(file) {
			const key = prefix + file
			const value = await read(key)
			seen.set(key, value)
			return value
		},
		async put(file, value) {
			const key = prefix + file
			await navigator.locks.request(key, async () => {
				if ((await read(key)) !== seen.get(key))
					throw new Error('配置已在其他页面修改，请重新读取后保存。')
				await browser.storage.local.set({ [key]: value })
				seen.set(key, value)
			})
		},
		async stat(file) {
			return (await read(prefix + file)) === undefined ? undefined : {}
		},
		subscribe(reload) {
			const changed = (changes: Record<string, unknown>) => {
				if (!Object.keys(changes).some((key) => key.startsWith(prefix))) return
				// Host enqueues adoption first. The page's status read waits for that transaction.
				reload()
				configChanges.dispatchEvent(new Event('change'))
			}
			browser.storage.local.onChanged.addListener(changed)
			return () => browser.storage.local.onChanged.removeListener(changed)
		},
	}
}
