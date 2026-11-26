import { browser } from 'wxt/browser'
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
	return browser.storage.local.set({ [key]: enabled })
}

export function resetPreferences() {
	return browser.storage.local.remove(ruleKeys)
}

export function watchPreferences(refresh: () => void) {
	const changed = (changes: Record<string, unknown>) => {
		if (ruleKeys.some((key) => Object.hasOwn(changes, key))) refresh()
	}
	browser.storage.local.onChanged.addListener(changed)
	return () => browser.storage.local.onChanged.removeListener(changed)
}
