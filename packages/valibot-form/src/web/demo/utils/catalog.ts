import type { CaseGroup, CaseGroupId, DemoCase } from '../data/cases'

export interface CaseIndex {
	tags: string[]
	searchMap: Map<string, string>
	groupOrder: Map<CaseGroupId, number>
}

export function buildCaseIndex(cases: DemoCase[], groups: CaseGroup[]): CaseIndex {
	const tags = new Set<string>()
	const searchMap = new Map<string, string>()
	for (const item of cases) {
		const parts = [item.id, item.label, item.description ?? '', ...item.tags]
		searchMap.set(item.id, parts.join(' ').toLowerCase())
		item.tags.forEach((tag) => tags.add(tag))
	}
	const groupOrder = new Map<CaseGroupId, number>()
	for (const group of groups) groupOrder.set(group.id, group.order)

	return {
		tags: Array.from(tags).sort((a, b) => a.localeCompare(b)),
		searchMap,
		groupOrder,
	}
}

export function normalizeQuery(value: string) {
	return value.trim().toLowerCase()
}

export function filterCases(
	cases: DemoCase[],
	filters: {
		query: string
		groupFilter: CaseGroupId | 'all'
		activeTags: string[]
	},
	searchMap: Map<string, string>,
): DemoCase[] {
	const queryValue = normalizeQuery(filters.query)
	return cases.filter((caseItem) => {
		if (filters.groupFilter !== 'all' && caseItem.group !== filters.groupFilter) return false
		const matchesQuery = !queryValue || (searchMap.get(caseItem.id) ?? '').includes(queryValue)
		const matchesTags =
			filters.activeTags.length === 0 ||
			filters.activeTags.every((tag) => caseItem.tags.includes(tag))
		return matchesQuery && matchesTags
	})
}

export function orderCases(cases: DemoCase[], groupOrder: Map<CaseGroupId, number>) {
	return [...cases].sort((a, b) => {
		const groupA = groupOrder.get(a.group) ?? 0
		const groupB = groupOrder.get(b.group) ?? 0
		if (groupA !== groupB) return groupA - groupB
		return (a.order ?? 0) - (b.order ?? 0)
	})
}

export function groupCases(cases: DemoCase[], groups: CaseGroup[]) {
	return groups
		.map((group) => {
			const items = cases.filter((item) => item.group === group.id)
			return items.length > 0 ? { group, cases: items } : null
		})
		.filter(Boolean) as { group: CaseGroup; cases: DemoCase[] }[]
}

export function resolveActiveCase(cases: DemoCase[], activeId: string): DemoCase | null {
	if (cases.length === 0) return null
	return cases.find((item) => item.id === activeId) ?? cases[0]
}

export function resolveNavigation(cases: DemoCase[], activeId: string) {
	const idx = cases.findIndex((item) => item.id === activeId)
	return {
		prevId: idx > 0 ? cases[idx - 1].id : null,
		nextId: idx !== -1 && idx < cases.length - 1 ? cases[idx + 1].id : null,
	}
}
