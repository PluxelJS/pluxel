import {
	formatPluginDefinitionReference,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginDependencyGraphSnapshot, PluginStatusSnapshot } from '@pluxel/runtime/web'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it } from 'vitest'
import { buildPluginDependencyGraphProjection } from '../src/app/plugins/pluginDependencyGraphModel'
import { selectPluginDependencyDetail } from '../src/app/plugins/pluginDependencyGraphSelectors'
import { PluginDependencyDetailContent } from '../src/app/plugins/detail/cards/PluginDependencyDetailCard'
import { buildPluginGraphEdgeHref } from '../src/app/plugin-graph/pluginGraphRoute'

const owner = node('OwnerPlugin')
const provider = node('ProviderPlugin')
const absent = node('AbsentOptional')
const dependent = node('DependentPlugin')
const inactiveDependent = node('InactiveDependent')

describe('plugin dependency detail', () => {
	it('renders compact current-plugin relations and keeps canonical identity out of visible labels', () => {
		const graph = Object.freeze({
			nodes: Object.freeze([
				Object.freeze({ status: status(dependent), effective: true }),
				Object.freeze({ status: status(inactiveDependent, false), effective: false }),
				Object.freeze({ status: status(owner), effective: true }),
				Object.freeze({ status: status(provider), effective: true }),
			]),
			edges: Object.freeze([
				resolvedEdge(dependent, owner, 'required', true),
				resolvedEdge(inactiveDependent, owner, 'optional', false),
				Object.freeze({
					consumer: owner,
					requirement: definition('UnresolvedRequirement'),
					mode: 'required' as const,
					resolution: Object.freeze({ state: 'unresolved' as const }),
					effective: false as const,
				}),
				resolvedEdge(owner, absent, 'optional', false),
				{
					...resolvedEdge(owner, provider, 'required', true, 'dependency-override'),
					requirement: definition('Cache'),
				},
			]),
		}) satisfies PluginDependencyGraphSnapshot
		const detail = selectPluginDependencyDetail(buildPluginDependencyGraphProjection(graph), owner)
		const Link = ({
			to,
			children,
			...props
		}: { to: string; children: ReactNode } & Omit<ComponentPropsWithoutRef<'a'>, 'href'>) => (
			<a href={to} {...props}>
				{children}
			</a>
		)

		const markup = renderToStaticMarkup(
			<MantineProvider>
				<PluginDependencyDetailContent detail={detail} LinkComponent={Link} />
			</MantineProvider>,
		)

		expect(markup).toContain('必须依赖')
		expect(markup).toContain('可选集成')
		expect(markup).toContain('被依赖')
		expect(markup).toContain('1 生效')
		expect(markup).toContain('1 未生效')
		expect(markup).toContain('Cache → Provider Plugin')
		expect(markup).toContain('Dependent Plugin')
		expect(markup).toContain('Inactive Dependent')
		expect(markup).not.toContain('Qualified Provider Plugin')
		expect(markup).toContain('UnresolvedRequirement')
		expect(markup).toContain('AbsentOptional')
		expect(markup).toContain('未解析')
		expect(markup).toContain('缺失')
		expect(markup).toContain('未生效')
		expect(markup).toContain('当前插件指定')
		expect(markup).not.toContain('运行中')
		expect(markup).not.toContain('有效节点')
		expect(markup).not.toContain('直接解析')
		expect(markup).not.toContain('解析方式')
		expect(markup).not.toContain(`>${formatPluginDefinitionReference(provider.definition)}<`)
		expect(markup).toContain(`href="/plugins/${status(provider).route}"`)
		expect(markup).toContain(`href="/plugins/${status(dependent).route}"`)
		expect(markup).not.toContain(`href="/plugins/${status(absent).route}"`)
		expect(markup.match(/aria-label="在依赖图中定位/g)).toHaveLength(5)
		expect(markup).toContain(`href="${buildPluginGraphEdgeHref(owner, definition('Cache'))}"`)
		expect(markup).toContain(`href="${buildPluginGraphEdgeHref(dependent, owner.definition)}"`)
	})
})

function resolvedEdge(
	consumer: PluginNodeAddress,
	resolvedProvider: PluginNodeAddress,
	mode: 'required' | 'optional',
	effective: boolean,
	via: 'direct' | 'provider-default' | 'dependency-override' = 'direct',
) {
	if (mode === 'optional') {
		return Object.freeze({
			consumer,
			requirement: resolvedProvider.definition,
			mode,
			resolution: Object.freeze({
				state: 'resolved' as const,
				provider: resolvedProvider,
				via,
			}),
			effective,
		})
	}
	return Object.freeze({
		consumer,
		requirement: resolvedProvider.definition,
		mode,
		resolution: Object.freeze({
			state: 'resolved' as const,
			provider: resolvedProvider,
			via,
		}),
		effective,
	})
}

function definition(exportName: string): PluginDefinitionAddress {
	return {
		entry: { kind: 'package-root', packageName: '@fixture/dependency-detail' },
		exportName,
	}
}

function node(exportName: string): PluginNodeAddress {
	return { definition: definition(exportName), variant: 'default' }
}

function status(address: PluginNodeAddress, running = true): PluginStatusSnapshot {
	const name = address.definition.exportName
	const displayName = name.replaceAll(/([a-z])([A-Z])/g, '$1 $2')
	return {
		address,
		reference: `package:@fixture/dependency-detail::${name}`,
		route: `v1/package/${name}/@fixture/dependency-detail`,
		displayName,
		label: { title: `Qualified ${displayName}`, text: `Qualified ${displayName}` },
		rootExportName: name,
		autoStart: running,
		sessionIntent: 'inherit',
		desiredState: running ? 'running' : 'stopped',
		activationReason: running ? 'auto-start' : null,
		lifecycleState: running ? 'running' : 'stopped',
		availability: 'available',
		issues: [],
		execution: {
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		recentUpdate: null,
	}
}
