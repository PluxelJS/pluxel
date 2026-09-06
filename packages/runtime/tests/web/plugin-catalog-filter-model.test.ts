import { describe, expect, it } from 'vitest'
import {
	DEFAULT_STATUS_FILTER,
	hasActiveSearchTokens,
	hasActiveStatusFilter,
	matchesGroupSearch,
	matchesPluginSearch,
} from '../../../workbench-app/src/app/plugins/catalog/filterModel'
import { parseSearchTokens } from '../../../workbench-app/src/app/plugins/catalog/searchTokens'

describe('plugin catalog filter model', () => {
	it('detects active token and status filters consistently', () => {
		expect(hasActiveSearchTokens(parseSearchTokens(''))).toBe(false)
		expect(hasActiveSearchTokens(parseSearchTokens('alpha @demo'))).toBe(true)
		expect(hasActiveStatusFilter(DEFAULT_STATUS_FILTER)).toBe(false)
		expect(
			hasActiveStatusFilter({
				...DEFAULT_STATUS_FILTER,
				unavailable: false,
			}),
		).toBe(true)
	})

	it('matches groups only against plain search tokens', () => {
		expect(matchesGroupSearch('Alpha Tools', parseSearchTokens('alpha tools'))).toBe(true)
		expect(matchesGroupSearch('Alpha Tools', parseSearchTokens('@pkg'))).toBe(false)
	})

	it('applies the same AND semantics across text and status filters', () => {
		const tokens = parseSearchTokens('alpha @demo ref:plugin exec:source-graph')
		const status = {
			name: 'Alpha Runner',
			packageName: '@demo/plugin-alpha',
			exportName: 'AlphaPlugin',
			reference: 'package:@demo/plugin-alpha::AlphaPlugin',
			executionSearchTerms: ['dynamic-entry', 'source-graph', 'source-module'],
			availability: 'available' as const,
			lifecycleState: 'running' as const,
		}

		expect(matchesPluginSearch('plugin-alpha', status, tokens, DEFAULT_STATUS_FILTER)).toBe(true)
		expect(
			matchesPluginSearch(
				'plugin-alpha',
				{
					...status,
					executionSearchTerms: ['dynamic-entry', 'entry-only', 'built-module'],
				},
				tokens,
				DEFAULT_STATUS_FILTER,
			),
		).toBe(false)
		expect(
			matchesPluginSearch('plugin-alpha', status, tokens, {
				running: false,
				stopped: true,
				unavailable: false,
			}),
		).toBe(false)
	})
})
