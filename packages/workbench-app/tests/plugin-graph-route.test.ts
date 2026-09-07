import {
	buildPluginGraphEdgeHref,
	buildPluginGraphNodeHref,
	parsePluginGraphFocus,
} from '../src/app/plugin-graph/pluginGraphRoute'
import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import { describe, expect, it } from 'vitest'

const consumer = {
	definition: {
		entry: {
			kind: 'source-entry',
			sourceSpace: 'workspace',
			path: 'plugins/percent%25/provider%2Ftext',
		},
		exportName: 'ConsumerPlugin%2F%25',
	},
	variant: 'fork',
	forkId: 'blue',
} as const satisfies PluginNodeAddress

const requirement = {
	entry: {
		kind: 'source-entry',
		sourceSpace: 'abstract-space',
		path: 'contracts/percent%25/base',
	},
	exportName: 'BaseProvider%2F%25',
} as const satisfies PluginDefinitionAddress

const scopedPackageNode = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/scoped-plugin' },
		exportName: 'ScopedPlugin',
	},
	variant: 'default',
} as const satisfies PluginNodeAddress

describe('plugin graph focus route', () => {
	it('round-trips node focus through canonical route segments', () => {
		const href = buildPluginGraphNodeHref(consumer)

		expect(parsePluginGraphFocus(href)).toEqual({ kind: 'node', address: consumer })
	})

	it('round-trips a scoped package default node', () => {
		const href = buildPluginGraphNodeHref(scopedPackageNode)

		expect(parsePluginGraphFocus(href)).toEqual({ kind: 'node', address: scopedPackageNode })
	})

	it('round-trips edge requirement references containing encoded slash and percent text', () => {
		const href = buildPluginGraphEdgeHref(consumer, requirement)

		expect(href).toContain('%252F')
		expect(href).toContain('%2525')
		expect(parsePluginGraphFocus(href)).toEqual({ kind: 'edge', consumer, requirement })
	})

	it.each([
		'plugin-graph/node/v1/package/Plugin/pkg',
		'/plugin-graph//node/v1/package/Plugin/pkg',
		'/plugin-graph/node/v1/package/Plugin/pkg/',
		'/plugin-graph/edge/not-a-node/requires/nope',
		'/plugin-graph/node/v1/package',
		'/plugin-graph/edge/v1/package/Plugin/pkg/requires/%',
		'/plugin-graph/unknown/value',
	])('treats malformed focus path as an unfocused graph: %s', (pathname) => {
		expect(parsePluginGraphFocus(pathname)).toBeNull()
	})
})
