import {
	detachWorkbenchPortableValue,
	type WorkbenchDetached,
	type WorkbenchPortableValue,
} from './client'

type DomainDto = {
	name: string
	nested: {
		count: number
	}
	items: string[]
	optional?: boolean
}

const dto = null as unknown as DomainDto
const detached = detachWorkbenchPortableValue(dto)
const promised = detachWorkbenchPortableValue(Promise.resolve(dto))
const transportOwned = null as unknown as PromiseLike<DomainDto & Disposable>
const transportDetached = detachWorkbenchPortableValue(transportOwned)

const detachedType: WorkbenchDetached<DomainDto> = detached
const promisedType: Promise<WorkbenchDetached<DomainDto>> = promised
const transportDetachedType: Promise<WorkbenchDetached<DomainDto>> = transportDetached
const portableScalars: readonly WorkbenchPortableValue[] = [null, true, 1, 'safe']

// @ts-expect-error Detached object fields are deeply readonly.
detached.nested.count = 2
// @ts-expect-error Detached arrays are deeply readonly.
detached.items.push('next')
// @ts-expect-error Functions are outside the portable value tree.
const nonPortableFunction: WorkbenchPortableValue = () => undefined

void detachedType
void promisedType
void transportDetachedType
void portableScalars
void nonPortableFunction
