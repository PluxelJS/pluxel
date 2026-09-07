import type { RpcTarget } from '../capnweb'
import { detachWorkbenchPortableValue, type WorkbenchDetached } from './client'
import { workbench } from './definition'
import { createWorkbenchRenderer, type WorkbenchResourceKey } from './react'

type SettingsSnapshot = Readonly<{
	mode: 'automatic' | 'manual'
	nested: Readonly<{ revision: number }>
	labels?: readonly string[]
}>

type SaveInput = Readonly<{ id: string; mode: SettingsSnapshot['mode'] }>

type SaveResult =
	| Readonly<{ ok: true; revision: number }>
	| Readonly<{ ok: false; message: string }>

type IsAny<Value> = 0 extends 1 & Value ? true : false
type IsExactly<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false
type Expect<Value extends true> = Value

interface SettingsApi extends RpcTarget {
	snapshot(): Promise<SettingsSnapshot>
	item(id: string): Promise<Readonly<{ id: string; enabled: boolean }>>
	labels(): Promise<readonly Readonly<{ id: string; label: string }>[]>
	selection(): Promise<Readonly<{ id: string }> | null>
	save(input: SaveInput): Promise<SaveResult>
	reset(): Promise<void>
	watch(invalidate: () => void): Disposable
}

interface OtherApi extends RpcTarget {
	inspect(): Promise<Readonly<{ value: string }>>
}

const renderer = workbench.entry(import.meta.url, './renderer-scope.type-probes.tsx')
const ProbeWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer,
		placement: workbench.tab(),
	}),
	other: workbench.view<OtherApi>({
		renderer,
		placement: workbench.tab(),
	}),
})

const settingsRenderer = createWorkbenchRenderer(ProbeWorkbench.settings)
const otherRenderer = createWorkbenchRenderer(ProbeWorkbench.other)

const settingsQuery = settingsRenderer.query(({ api }) => ({
	queryKey: ['settings', 'snapshot'] as const,
	queryFn: (context) => {
		const { queryKey, signal } = context
		// @ts-expect-error The per-open QueryClient is intentionally not part of the author context.
		context.client
		const key: readonly WorkbenchResourceKey[] = queryKey
		const querySignal: AbortSignal = signal
		void key
		void querySignal
		return api.snapshot()
	},
	workbench: {
		subscribe: ({ invalidate, signal }) => {
			const subscriptionSignal: AbortSignal = signal
			void subscriptionSignal
			return api.watch(invalidate)
		},
	},
}))

const itemQuery = settingsRenderer.queryFamily(({ api }, input: Readonly<{ id: string }>) => ({
	queryKey: ['settings', 'item', input.id] as const,
	queryFn: () => api.item(input.id),
	workbench: {
		subscribe: ({ invalidate }) => {
			const id: string = input.id
			void id
			return api.watch(invalidate)
		},
	},
}))

const labelsQuery = settingsRenderer.query(({ api }) => ({
	queryKey: ['settings', 'labels'] as const,
	queryFn: () => api.labels(),
}))

const selectionQuery = settingsRenderer.query(({ api }) => ({
	queryKey: ['settings', 'selection'] as const,
	queryFn: () => api.selection(),
}))

const promisedQuery = settingsRenderer.query(() => ({
	queryKey: ['settings', 'promised'] as const,
	queryFn: () => Promise.resolve({ source: 'promise' as const }),
}))

const synchronousQuery = settingsRenderer.query(() => ({
	queryKey: ['settings', 'synchronous'] as const,
	queryFn: () => ({ source: 'sync' as const }),
}))

const explicitSettingsQuery = settingsRenderer.query(({ api }) => ({
	queryKey: ['settings', 'explicit'] as const,
	queryFn: (): Promise<SettingsSnapshot> => api.snapshot(),
}))

const otherQuery = otherRenderer.query(({ api }) => ({
	queryKey: ['other', 'inspect'] as const,
	queryFn: () => api.inspect(),
}))

const saveSettings = settingsRenderer.mutation(({ api, signal }) => {
	const mutationSignal: AbortSignal = signal
	void mutationSignal
	return {
		mutationFn: (input: SaveInput) => api.save(input),
		workbench: {
			invalidates: (input: SaveInput) => [settingsQuery, itemQuery.target({ id: input.id })],
		},
	}
})

const resetSettings = settingsRenderer.mutation(({ api }) => ({
	mutationFn: () => api.reset(),
	workbench: {
		invalidates: [settingsQuery],
	},
}))

settingsRenderer.mutation(({ api }) => ({
	mutationFn: (input: SaveInput) => api.save(input),
	workbench: {
		invalidates: [settingsQuery],
	},
}))

settingsRenderer.query(({ api }) => ({
	queryKey: ['settings', 'legacy-watch'] as const,
	queryFn: () => api.snapshot(),
	// @ts-expect-error Workbench subscriptions are namespaced under workbench.subscribe.
	watch: () => api.watch(() => undefined),
}))

// @ts-expect-error Query option factories reject unknown top-level fields.
settingsRenderer.query(({ api }) => ({
	queryKey: ['settings', 'unknown-query-option'] as const,
	queryFn: () => api.snapshot(),
	unknown: true,
}))

// @ts-expect-error Query option factories reject unknown Workbench fields.
settingsRenderer.query(({ api }) => ({
	queryKey: ['settings', 'unknown-query-workbench-option'] as const,
	queryFn: () => api.snapshot(),
	workbench: {
		subscribe: ({ invalidate }) => api.watch(invalidate),
		unknown: true,
	},
}))

settingsRenderer.mutation(({ api }) => ({
	mutationFn: () => api.reset(),
	// @ts-expect-error Workbench invalidations are namespaced under workbench.invalidates.
	invalidates: [settingsQuery],
}))

// @ts-expect-error Mutation option factories reject unknown top-level fields.
settingsRenderer.mutation(({ api }) => ({
	mutationFn: () => api.reset(),
	unknown: true,
}))

// @ts-expect-error Mutation option factories reject unknown Workbench fields.
settingsRenderer.mutation(({ api }) => ({
	mutationFn: () => api.reset(),
	workbench: {
		invalidates: [settingsQuery],
		unknown: true,
	},
}))

settingsRenderer.mutation(({ api }) => ({
	// @ts-expect-error A mutation accepts one variables value, not a domain argument list.
	mutationFn: (input: SaveInput, _extra: number) => api.save(input),
}))

settingsRenderer.mutation(({ api }) => ({
	mutationFn: (input: SaveInput) => api.save(input),
	workbench: {
		// @ts-expect-error An invalidation target from a different descriptor is rejected by type.
		invalidates: [otherQuery],
	},
}))

// @ts-expect-error A concrete query is already an exact invalidation target.
settingsQuery.target()

function SettingsPage() {
	const { api } = settingsRenderer.useWorkbench()
	const settings = settingsQuery.useQuery()
	const item = itemQuery.useQuery({ id: 'first' })
	const labels = labelsQuery.useQuery()
	const selection = selectionQuery.useQuery()
	const promised = promisedQuery.useQuery()
	const synchronous = synchronousQuery.useQuery()
	const explicitSettings = explicitSettingsQuery.useQuery()
	const save = saveSettings.useMutation()
	const reset = resetSettings.useMutation()
	const directlyDetachedLabels = detachWorkbenchPortableValue(api.labels())
	const directlyDetachedSave = detachWorkbenchPortableValue(
		api.save({ id: 'first', mode: 'manual' }),
	)

	type _SettingsDataIsNotAny = Expect<IsAny<typeof settings.data> extends false ? true : false>
	type _SettingsDataIsExact = Expect<
		IsExactly<typeof settings.data, WorkbenchDetached<SettingsSnapshot> | undefined>
	>
	type _SettingsRefetchIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof settings.refetch>>> extends false ? true : false
	>
	type _SettingsRefetchIsExact = Expect<
		IsExactly<ReturnType<typeof settings.refetch>, Promise<WorkbenchDetached<SettingsSnapshot>>>
	>
	type _ItemDataIsNotAny = Expect<IsAny<typeof item.data> extends false ? true : false>
	type _ItemDataIsExact = Expect<
		IsExactly<
			typeof item.data,
			WorkbenchDetached<Readonly<{ id: string; enabled: boolean }>> | undefined
		>
	>
	type _ItemRefetchIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof item.refetch>>> extends false ? true : false
	>
	type _ItemRefetchIsExact = Expect<
		IsExactly<
			ReturnType<typeof item.refetch>,
			Promise<WorkbenchDetached<Readonly<{ id: string; enabled: boolean }>>>
		>
	>
	type _LabelsDataIsNotAny = Expect<IsAny<typeof labels.data> extends false ? true : false>
	type _LabelsDataIsExact = Expect<
		IsExactly<
			typeof labels.data,
			WorkbenchDetached<readonly Readonly<{ id: string; label: string }>[]> | undefined
		>
	>
	type _LabelsRefetchIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof labels.refetch>>> extends false ? true : false
	>
	type _LabelsRefetchIsExact = Expect<
		IsExactly<
			ReturnType<typeof labels.refetch>,
			Promise<WorkbenchDetached<readonly Readonly<{ id: string; label: string }>[]>>
		>
	>
	type _SelectionDataIsNotAny = Expect<IsAny<typeof selection.data> extends false ? true : false>
	type _SelectionDataIsExact = Expect<
		IsExactly<typeof selection.data, WorkbenchDetached<Readonly<{ id: string }> | null> | undefined>
	>
	type _SelectionRefetchIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof selection.refetch>>> extends false ? true : false
	>
	type _SelectionRefetchIsExact = Expect<
		IsExactly<
			ReturnType<typeof selection.refetch>,
			Promise<WorkbenchDetached<Readonly<{ id: string }> | null>>
		>
	>
	type _PromisedDataIsNotAny = Expect<IsAny<typeof promised.data> extends false ? true : false>
	type _PromisedDataIsExact = Expect<
		IsExactly<typeof promised.data, WorkbenchDetached<{ source: 'promise' }> | undefined>
	>
	type _PromisedRefetchIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof promised.refetch>>> extends false ? true : false
	>
	type _PromisedRefetchIsExact = Expect<
		IsExactly<
			ReturnType<typeof promised.refetch>,
			Promise<WorkbenchDetached<{ source: 'promise' }>>
		>
	>
	type _SynchronousDataIsNotAny = Expect<
		IsAny<typeof synchronous.data> extends false ? true : false
	>
	type _SynchronousDataIsExact = Expect<
		IsExactly<typeof synchronous.data, WorkbenchDetached<{ source: 'sync' }> | undefined>
	>
	type _SynchronousRefetchIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof synchronous.refetch>>> extends false ? true : false
	>
	type _SynchronousRefetchIsExact = Expect<
		IsExactly<
			ReturnType<typeof synchronous.refetch>,
			Promise<WorkbenchDetached<{ source: 'sync' }>>
		>
	>
	type _ExplicitDataIsNotAny = Expect<
		IsAny<typeof explicitSettings.data> extends false ? true : false
	>
	type _ExplicitDataIsExact = Expect<
		IsExactly<typeof explicitSettings.data, WorkbenchDetached<SettingsSnapshot> | undefined>
	>
	type _DirectLabelsIsNotAny = Expect<
		IsAny<Awaited<typeof directlyDetachedLabels>> extends false ? true : false
	>
	type _DirectLabelsIsExact = Expect<
		IsExactly<
			typeof directlyDetachedLabels,
			Promise<WorkbenchDetached<readonly Readonly<{ id: string; label: string }>[]>>
		>
	>
	type _DirectSaveIsNotAny = Expect<
		IsAny<Awaited<typeof directlyDetachedSave>> extends false ? true : false
	>
	type _DirectSaveIsExact = Expect<
		IsExactly<typeof directlyDetachedSave, Promise<WorkbenchDetached<SaveResult>>>
	>
	type _SaveDataIsNotAny = Expect<IsAny<typeof save.data> extends false ? true : false>
	type _SaveDataIsExact = Expect<
		IsExactly<typeof save.data, WorkbenchDetached<SaveResult> | undefined>
	>
	type _SaveMutationIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof save.mutateAsync>>> extends false ? true : false
	>
	type _SaveMutationIsExact = Expect<
		IsExactly<ReturnType<typeof save.mutateAsync>, Promise<WorkbenchDetached<SaveResult>>>
	>
	type _ResetDataIsNotAny = Expect<IsAny<typeof reset.data> extends false ? true : false>
	type _ResetDataIsExact = Expect<IsExactly<typeof reset.data, void>>
	type _ResetMutationIsNotAny = Expect<
		IsAny<Awaited<ReturnType<typeof reset.mutateAsync>>> extends false ? true : false
	>
	type _ResetMutationIsExact = Expect<
		IsExactly<ReturnType<typeof reset.mutateAsync>, Promise<void>>
	>

	api.snapshot()
	const saveResult: Promise<WorkbenchDetached<SaveResult>> = save.mutateAsync({
		id: 'first',
		mode: 'manual',
	})
	const resetResult: Promise<void> = reset.mutateAsync()
	const saveVoid: void = save.mutate({ id: 'first', mode: 'manual' })
	const resetVoid: void = reset.mutate()
	void settings.refetch().catch(() => {})
	save.mutate({ id: 'first', mode: 'manual' })
	reset.mutate()
	// @ts-expect-error Mutation input is inferred without an explicit generic.
	save.mutate({ id: 1, mode: 'manual' })
	// @ts-expect-error The exact descriptor exposes SettingsApi, not OtherApi.
	api.inspect()

	const snapshot: WorkbenchDetached<SettingsSnapshot> | undefined = settings.data
	const enabled: boolean | undefined = item.data?.enabled
	const labelNames: string[] | undefined = labels.data?.map((label) => label.label)
	const selected: Readonly<{ readonly id: string }> | null | undefined = selection.data
	const selectedId: string | undefined = selection.data?.id
	const promisedSource: 'promise' | undefined = promised.data?.source
	const synchronousSource: 'sync' | undefined = synchronous.data?.source
	const saveOutcome: WorkbenchDetached<SaveResult> | undefined = save.data
	void saveResult
	void resetResult
	void saveVoid
	void resetVoid
	void labelNames
	void selectedId
	void selected
	void promisedSource
	void synchronousSource
	void saveOutcome
	return <p>{`${snapshot?.nested.revision ?? 0}:${enabled ?? false}`}</p>
}

const SettingsRenderer = settingsRenderer.render(SettingsPage)

void SettingsRenderer
