import * as Workbench from '@pluxel/workbench'
import * as WorkbenchClient from '@pluxel/workbench/client'
import * as WorkbenchReact from '@pluxel/workbench/react'
import { describe, expect, it } from 'vitest'

describe('Workbench public author surface', () => {
	it('keeps definition, client, and React entries narrow', () => {
		expect(Object.keys(Workbench).sort()).toEqual(['Workbench', 'workbench'])
		expect(Object.keys(WorkbenchClient).sort()).toEqual([
			'WorkbenchOpenedContentHandle',
			'WorkbenchOpenedViewHandle',
			'WorkbenchPortableValueError',
			'createRemoteValue',
			'detachWorkbenchPortableValue',
			'openWorkbenchEntry',
			'readWorkbenchLayout',
		])
		expect(Object.keys(WorkbenchReact).sort()).toEqual([
			'WorkbenchPane',
			'WorkbenchPaneLayout',
			'WorkbenchRendererError',
			'createWorkbenchRenderer',
			'useRemoteValue',
			'useWorkbench',
			'useWorkbenchPaneLayout',
		])
	})
})
