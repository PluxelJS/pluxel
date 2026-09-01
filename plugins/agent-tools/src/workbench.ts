import { f, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import type { AgentToolsSnapshot } from './contracts.ts'

const AgentToolBehaviorSchema = v.variant('kind', [
	v.object({
		kind: v.pipe(v.literal('query'), f.formMeta({ title: 'Kind' })),
		world: v.pipe(v.picklist(['closed', 'open']), f.formMeta({ title: 'World' })),
	}),
	v.object({
		kind: v.pipe(v.literal('mutation'), f.formMeta({ title: 'Kind' })),
		destructive: v.pipe(v.boolean(), f.formMeta({ title: 'Destructive' })),
		idempotent: v.pipe(v.boolean(), f.formMeta({ title: 'Idempotent' })),
		world: v.pipe(v.picklist(['closed', 'open']), f.formMeta({ title: 'World' })),
	}),
])

const AgentToolsStatusSchema: v.GenericSchema<unknown, AgentToolsSnapshot> = v.pipe(
	v.object({
		policyRevision: v.pipe(
			v.number(),
			v.integer(),
			v.minValue(0),
			f.formMeta({ title: 'Policy revision' }),
		),
		catalogRevision: v.pipe(
			v.number(),
			v.integer(),
			v.minValue(0),
			f.formMeta({ title: 'Catalog revision' }),
		),
		commands: v.pipe(
			v.array(
				v.object({
					name: v.pipe(v.string(), f.formMeta({ title: 'Name' })),
					title: v.pipe(v.optional(v.string()), f.formMeta({ title: 'Title' })),
					description: v.pipe(v.string(), f.formMeta({ title: 'Description' })),
					behavior: v.pipe(AgentToolBehaviorSchema, f.formMeta({ title: 'Behavior' })),
				}),
			),
			f.formMeta({ title: 'Published commands' }),
		),
		toolsets: v.pipe(
			v.array(
				v.object({
					id: v.pipe(v.string(), f.formMeta({ title: 'Toolset ID' })),
					label: v.pipe(v.string(), f.formMeta({ title: 'Name' })),
					description: v.pipe(v.optional(v.string()), f.formMeta({ title: 'Description' })),
					commandNames: v.pipe(v.array(v.string()), f.formMeta({ title: 'Configured commands' })),
					availableCommandNames: v.pipe(
						v.array(v.string()),
						f.formMeta({ title: 'Available commands' }),
					),
					missingCommandNames: v.pipe(
						v.array(v.string()),
						f.formMeta({ title: 'Missing commands' }),
					),
				}),
			),
			f.formMeta({ title: 'Toolsets' }),
		),
		assignments: v.pipe(
			v.array(
				v.object({
					agentId: v.pipe(v.string(), f.formMeta({ title: 'Agent ID' })),
					label: v.pipe(v.string(), f.formMeta({ title: 'Name' })),
					toolsetIds: v.pipe(v.array(v.string()), f.formMeta({ title: 'Toolsets' })),
					commandNames: v.pipe(v.array(v.string()), f.formMeta({ title: 'Assigned commands' })),
					availableCommandNames: v.pipe(
						v.array(v.string()),
						f.formMeta({ title: 'Available commands' }),
					),
					missingCommandNames: v.pipe(
						v.array(v.string()),
						f.formMeta({ title: 'Missing commands' }),
					),
				}),
			),
			f.formMeta({ title: 'Agent assignments' }),
		),
		ungroupedCommandNames: v.pipe(v.array(v.string()), f.formMeta({ title: 'Ungrouped commands' })),
	}),
	f.formMeta({ title: 'Agent tools status' }),
)

export const AgentToolsWorkbench = workbench.define({
	overview: workbench.content({
		document: workbench.markdown(import.meta.url, './workbench-guide.md', {
			status: workbench.data(AgentToolsStatusSchema),
		}),
		placement: workbench.route('/agent-tools', {
			title: 'Agent tools',
			icon: workbench.icons.Settings,
			navigation: { label: 'Agent tools' },
			order: 70,
		}),
	}),
})
