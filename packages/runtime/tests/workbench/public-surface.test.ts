import * as Workbench from '@pluxel/runtime/workbench'
import * as WorkbenchClient from '@pluxel/runtime/workbench/client'
import * as WorkbenchReact from '@pluxel/runtime/workbench/react'
import { describe, expect, it } from 'vitest'

describe('Workbench public author surface', () => {
	it('keeps definition, client, and React entries narrow', () => {
		expect(Object.keys(Workbench).sort()).toEqual(['workbench'])
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
