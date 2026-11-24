import { RpcTarget, type RpcStub } from 'capnweb'
import {
	workbench,
	type PluginWorkbench,
	type WorkbenchBindings,
	type WorkbenchPublication,
} from './definition.ts'
import { createWorkbenchRenderer, type WorkbenchHookValue } from './react.tsx'
import type { BasePlugin } from '@pluxel/core'
import * as v from 'valibot'

interface LocalApi extends RpcTarget {
	snapshot(): Readonly<{ revision: number }>
}

interface ProviderApi extends RpcTarget {
	list(): readonly string[]
}

interface ConsumerApi extends RpcTarget {
	select(id: string): Promise<boolean>
}

class LocalTarget extends RpcTarget implements LocalApi {
	snapshot() {
		return { revision: 1 }
	}
}

class ConsumerTarget extends RpcTarget implements ConsumerApi {
	async select(_id: string) {
		return true
	}
}

const renderer = './definition.type-probes.ts'

const ProviderWorkbench = workbench.define(import.meta.url, {
	settings: workbench.attachment<ProviderApi>({ renderer }),
	picker: workbench.attachment<ProviderApi, ConsumerApi>({ renderer }),
})

const rawView = workbench.view<LocalApi>({ renderer, placement: { kind: 'tab' } })
// @ts-expect-error Only a descriptor in a definition can bind a renderer.
createWorkbenchRenderer(rawView)
// @ts-expect-error Plain records lack the declaration returned by a builder.
workbench.define(import.meta.url, { fake: { kind: 'view' } })
// @ts-expect-error A definition-owned descriptor cannot be rebound to another definition.
workbench.define(import.meta.url, { duplicate: ProviderWorkbench.settings })
// @ts-expect-error A reusable attachment is placeable after its provider definition owns it.
workbench.attachment<ProviderApi>({ renderer }).place({ kind: 'tab' })

const refresh = workbench.action({ label: 'Refresh' })
// @ts-expect-error Explicit interactive slots must have matching declarations.
workbench.content<{ refresh: typeof refresh }>({
	document: './guide.md',
	placement: { kind: 'tab' },
})

const ConsumerWorkbench = workbench.define(import.meta.url, {
	local: workbench.view<LocalApi>({
		renderer,
		placement: { kind: 'tab' },
	}),
	settings: ProviderWorkbench.settings.place({ kind: 'tab' }),
	picker: ProviderWorkbench.picker.place({ kind: 'tab' }),
})

const ContentWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './guide.md',
		placement: { kind: 'tab' },
	}),
})

const InteractiveContentWorkbench = workbench.define(import.meta.url, {
	status: workbench.content({
		document: './guide.md',
		slots: {
			state: workbench.data(v.object({ ready: v.boolean() })),
			history: workbench.data(
				v.object({ entries: v.array(v.object({ labels: v.array(v.string()) })) }),
			),
			refresh: workbench.action({ label: 'Refresh' }),
			probe: workbench.action({
				label: 'Probe',
				input: v.object({ timeoutMs: v.number(), labels: v.array(v.string()) }),
			}),
		},
		placement: { kind: 'tab' },
	}),
})

const MixedWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({ document: './guide.md', placement: { kind: 'tab' } }),
	local: workbench.view<LocalApi>({ renderer, placement: { kind: 'tab' } }),
})

declare const provider: BasePlugin
declare const pluginWorkbench: PluginWorkbench
const detachedHistory = { entries: [{ labels: ['ready'] }] } as const

pluginWorkbench.publish(ContentWorkbench).link('guide')
pluginWorkbench.publish(MixedWorkbench, { local: () => new LocalTarget() })
pluginWorkbench.publish(InteractiveContentWorkbench, {
	status: ({ signal }) => {
		signal.throwIfAborted()
		return {
			subscribe: (changed) => {
				changed()
				return { [Symbol.dispose]() {} }
			},
			load: () => ({ state: { ready: true }, history: detachedHistory }),
			actions: {
				refresh: () => undefined,
				probe: (input) => {
					input.labels.push('checked')
					return { ok: true, message: String(input.timeoutMs) }
				},
			},
		}
	},
})
// @ts-expect-error Markdown-only Content publication has no bindings argument.
pluginWorkbench.publish(ContentWorkbench, {})
// @ts-expect-error A mixed definition still requires its non-Content binding.
pluginWorkbench.publish(MixedWorkbench)
// @ts-expect-error Content keys never enter the bindings record.
pluginWorkbench.publish(MixedWorkbench, { local: () => new LocalTarget(), guide: () => null })
// @ts-expect-error Interactive Content requires a binding.
pluginWorkbench.publish(InteractiveContentWorkbench)
pluginWorkbench.publish(InteractiveContentWorkbench, {
	status: () => ({
		// @ts-expect-error load must return every data slot with its inferred output.
		load: () => ({}),
		actions: {
			refresh: () => undefined,
			probe: () => undefined,
		},
	}),
})
pluginWorkbench.publish(InteractiveContentWorkbench, {
	status: () => ({
		load: () => ({ state: { ready: true }, history: detachedHistory }),
		// @ts-expect-error Subscription registration returns a synchronous Disposable.
		subscribe: async () => ({ [Symbol.dispose]() {} }),
		actions: { refresh: () => undefined, probe: () => undefined },
	}),
})

const validBindings = {
	local: () => new LocalTarget(),
	settings: { provider },
	picker: {
		provider,
		consumer: () => new ConsumerTarget(),
	},
} satisfies WorkbenchBindings<typeof ConsumerWorkbench>

const published = pluginWorkbench.publish(ConsumerWorkbench, validBindings)
published.link('local')
published.link('picker')
// @ts-expect-error A handle only knows its own definition's keys.
published.link('guide')
// @ts-expect-error Route parameter values must be strings.
published.link('local', { id: 3 })
declare const providerPublication: WorkbenchPublication<typeof ProviderWorkbench>
// @ts-expect-error A provider's unplaced Attachment is not a document.
providerPublication.link('settings')

type LocalStub = RpcStub<LocalApi>
declare const localStub: LocalStub
const result = localStub.snapshot()

type ProviderOnlyHook = WorkbenchHookValue<typeof ProviderWorkbench.settings>
declare const providerOnlyHook: ProviderOnlyHook
const providerSnapshot = providerOnlyHook.provider.list()

type ConsumerHook = WorkbenchHookValue<typeof ProviderWorkbench.picker>
declare const consumerHook: ConsumerHook
const consumerSelection = consumerHook.consumer.select('first')

void validBindings
void result
void providerSnapshot
void consumerSelection

// @ts-expect-error Workbench APIs must be actual Cap'n Web targets.
workbench.view<{ snapshot(): number }>({ renderer, placement: { kind: 'tab' } })

const invalidProviderOnly: WorkbenchBindings<typeof ConsumerWorkbench> = {
	...validBindings,
	// @ts-expect-error A provider-only Attachment has no consumer factory.
	settings: { provider, consumer: () => new ConsumerTarget() },
}

// @ts-expect-error Every definition key must be bound exactly once.
const missingBinding: WorkbenchBindings<typeof ConsumerWorkbench> = {
	settings: { provider },
	picker: { provider, consumer: () => new ConsumerTarget() },
}

void invalidProviderOnly
void missingBinding
