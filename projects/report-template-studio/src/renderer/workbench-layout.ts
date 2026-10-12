import type { OpenDocumentOptions, WorkbenchDocument } from '@worksplit/react'
import {
	DockLocation,
	type IGlobalAttributes,
	type IJsonBorderNode,
	type IJsonModel,
	type IJsonRowNode,
	type IJsonTabGroupNode,
	type IJsonTabNode,
	type IJsonTabSetNode,
} from 'flexlayout-react'

export const studioLayoutGlobal: IGlobalAttributes = {
	tabEnableFloat: false,
	tabEnablePopout: false,
	tabEnableScrollbars: false,
	tabSetEnableCloseButton: true,
	tabSetEnableDeleteWhenEmpty: true,
	tabSetMinWidth: 220,
	tabSetMinHeight: 120,
}

export const assistantTab: IJsonTabNode = {
	type: 'tab',
	id: 'assistant',
	name: 'AI 助手',
	component: 'worksplit.tool',
	enableClose: true,
	enableDrag: true,
	enableScrollbars: false,
}

export function createStudioLayout(): IJsonModel {
	return {
		global: { ...studioLayoutGlobal },
		borders: [
			{
				type: 'border',
				location: 'bottom',
				size: 240,
				minSize: 160,
				enableAutoHide: true,
				selected: 0,
				children: [{ ...assistantTab }],
			},
			{
				type: 'border',
				location: 'right',
				size: 360,
				minSize: 260,
				enableAutoHide: true,
				selected: -1,
				children: [],
			},
		],
		// Native FlexLayout keeps one empty editor group and recycles every other
		// empty group. The first preview creates its split through open(location).
		layout: { type: 'row', children: [] },
	}
}

export function editorGroups(row: IJsonRowNode): IJsonTabSetNode[] {
	return (row.children ?? []).flatMap((child) =>
		child.type === 'row' ? editorGroups(child as IJsonRowNode) : [child as IJsonTabSetNode],
	)
}

type DocumentKind = 'file' | 'form' | 'preview'

export function documentTarget(
	kind: DocumentKind,
	layout: IJsonModel,
	documents: readonly WorkbenchDocument[],
	activeGroupId: string | null,
): Pick<OpenDocumentOptions, 'target' | 'location'> {
	const groups = editorGroups(layout.layout)
	const related = documents.filter(
		(document) =>
			(new URL(document.href, 'https://studio.invalid').pathname === '/preview') ===
			(kind === 'preview'),
	)
	const existing =
		related.find((document) => document.containerId === activeGroupId) ?? related.at(-1)
	if (existing) return { target: existing.containerId }
	const empty = groups.find((group) => !group.children?.length)
	if (empty) return { target: empty.id }
	const reference = groups.find((group) => group.id === activeGroupId) ?? groups[0]
	return {
		target: reference?.id,
		location: kind === 'preview' ? DockLocation.RIGHT : DockLocation.LEFT,
	}
}

function isTabGroup(node: IJsonTabNode | IJsonTabGroupNode): node is IJsonTabGroupNode {
	return node.type === 'tabgroup'
}

export function findTool(layout: IJsonModel, id: string) {
	const containers: (IJsonTabSetNode | IJsonBorderNode)[] = [
		...editorGroups(layout.layout),
		...(layout.borders ?? []),
	]
	for (const container of containers) {
		const children = container.children ?? []
		const tabs = children.flatMap((child) =>
			isTabGroup(child) ? (child.opened === false ? [] : (child.children ?? [])) : [child],
		)
		for (const child of children) {
			const group = isTabGroup(child) ? child : undefined
			const tab = isTabGroup(child)
				? child.children?.find((candidate) => candidate.id === id)
				: child
			if (tab?.id === id)
				return {
					tab,
					container,
					group,
					selected:
						tabs.indexOf(tab) === (container.selected ?? (container.type === 'border' ? -1 : 0)),
				}
		}
	}
	return undefined
}
