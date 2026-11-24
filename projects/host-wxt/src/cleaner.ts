import { ruleKeys, type RuleKey } from './rules'

export class LinkCleaner {
	private readonly filters = new Map<RuleKey, (link: string) => string>()

	register(key: RuleKey, filter: (link: string) => string) {
		const filters = this.filters
		if (filters.has(key)) throw new Error(`清理规则重复注册：${key}`)
		filters.set(key, filter)
		return () => {
			filters.delete(key)
		}
	}

	clean(input: string) {
		let link = input.trim()
		if (!URL.canParse(link) || !['http:', 'https:'].includes(new URL(link).protocol))
			throw new Error('请输入完整的 HTTP 或 HTTPS 链接。')
		const changed: RuleKey[] = []
		for (const key of ruleKeys) {
			const next = this.filters.get(key)?.(link) ?? link
			if (next !== link) changed.push(key)
			link = next
		}
		return { link, changed }
	}
}
