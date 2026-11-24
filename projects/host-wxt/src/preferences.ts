import { browser } from 'wxt/browser'
import { storage } from 'wxt/utils/storage'
import { ruleKeys, ruleDefaults, type RuleKey } from './rules'

export async function readPreferences(): Promise<Record<RuleKey, boolean>> {
	const saved = await browser.storage.local.get(ruleKeys)
	const choices = {} as Record<RuleKey, boolean>
	for (const key of ruleKeys) {
		const value = saved[key] === undefined ? ruleDefaults[key] : saved[key]
		if (typeof value !== 'boolean') throw new TypeError(`设置 ${key} 必须是布尔值`)
		choices[key] = value
	}
	return choices
}

export function setPreference(key: RuleKey, enabled: boolean) {
	return storage.setItem(`local:${key}`, enabled)
}

export function resetPreferences() {
	return storage.removeItems(ruleKeys.map((key) => `local:${key}` as const))
}

export function watchPreferences(refresh: () => void) {
	const remove = ruleKeys.map((key) => storage.watch(`local:${key}`, refresh))
	return () => {
		for (const unwatch of remove) unwatch()
	}
}
