import { RpcTarget, type RpcStub } from '../capnweb'
import { workbench, type WorkbenchBindings } from './definition'
import { type WorkbenchHookValue } from './react'
import type { BasePlugin } from '@pluxel/core'

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

const renderer = workbench.entry(import.meta.url, './definition.type-probes.ts')

const ProviderWorkbench = workbench.define({
	settings: workbench.attachment<ProviderApi>({ renderer }),
	picker: workbench.attachment<ProviderApi, ConsumerApi>({ renderer }),
})

const ConsumerWorkbench = workbench.define({
	local: workbench.view<LocalApi>({
		renderer,
		placement: workbench.tab(),
	}),
	settings: ProviderWorkbench.settings.place(workbench.tab()),
	picker: ProviderWorkbench.picker.place(workbench.tab()),
})

declare const provider: BasePlugin

const validBindings = {
	local: () => new LocalTarget(),
	settings: { provider },
	picker: {
		provider,
		consumer: () => new ConsumerTarget(),
	},
} satisfies WorkbenchBindings<typeof ConsumerWorkbench>

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
workbench.view<{ snapshot(): number }>({ renderer, placement: workbench.tab() })

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
