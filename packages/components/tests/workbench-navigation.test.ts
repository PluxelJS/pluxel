import { describe, expect, it } from 'vitest'
import { groupNavItems } from '../src/app/navigation/navConfig'

describe('Workbench navigation groups', () => {
	it('collapses grouped routes into one primary section and preserves child order', () => {
		const items = groupNavItems([
			{ label: '首页', href: '/' },
			{
				label: 'Sandbox',
				href: '/ext/Sandbox/sandbox',
				group: { id: 'bots', label: 'Bots' },
			},
			{
				label: 'Telegram',
				href: '/ext/Telegram/settings',
				group: { id: 'bots', label: 'Bots' },
			},
			{ label: '用户', href: '/ext/Access/access' },
		])

		expect(items).toHaveLength(3)
		expect(items[1]).toMatchObject({
			label: 'Bots',
			href: '/ext/Sandbox/sandbox',
			children: [
				{ label: 'Sandbox', href: '/ext/Sandbox/sandbox' },
				{ label: 'Telegram', href: '/ext/Telegram/settings' },
			],
		})
	})

	it('does not merge routes from different group ids with the same label', () => {
		const items = groupNavItems([
			{ label: 'A', href: '/a', group: { id: 'first', label: 'Tools' } },
			{ label: 'B', href: '/b', group: { id: 'second', label: 'Tools' } },
		])

		expect(items).toHaveLength(2)
		expect(items.map((item) => item.children?.[0]?.href)).toEqual(['/a', '/b'])
	})
})
