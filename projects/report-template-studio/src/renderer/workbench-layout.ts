import type { ContainerInfo, Destination, DocumentInfo } from '@worksplit/react'
import {
	DockLocation,
	type IGlobalAttributes,
	type IJsonModel,
	type IJsonTabNode,
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
	component: 'studio.assistant',
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

type DocumentKind = 'file' | 'form' | 'preview'

/** Preserve the user's existing editor/preview grouping; create a neighboring group only when needed. */
export function documentTarget(
	kind: DocumentKind,
	containers: readonly ContainerInfo[],
	documents: readonly DocumentInfo[],
	activeContainerId: string | null,
): Destination | undefined {
	const groups = containers.filter((container) => container.kind === 'tabset')
	const related = documents.filter(
		(document) =>
			(new URL(document.href, 'https://studio.invalid').pathname === '/preview') ===
			(kind === 'preview'),
	)
	const existing =
		related.find((document) => document.containerId === activeContainerId) ?? related.at(-1)
	if (existing?.containerId) return { target: existing.containerId, location: DockLocation.CENTER }
	const empty = groups.find((group) => group.tabIds.length === 0)
	if (empty) return { target: empty.id, location: DockLocation.CENTER }
	const reference = groups.find((group) => group.id === activeContainerId) ?? groups[0]
	return reference
		? {
				target: reference.id,
				location: kind === 'preview' ? DockLocation.RIGHT : DockLocation.LEFT,
			}
		: undefined
}
