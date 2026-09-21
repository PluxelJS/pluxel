import {
	consumeWorkbenchValue,
	type WorkbenchSnapshot,
	type WorkbenchPortableValue,
} from './client.ts'

type DomainDto = {
	name: string
	nested: {
		count: number
	}
	items: string[]
	optional?: boolean
}

const dto = null as unknown as DomainDto
const detached = consumeWorkbenchValue(dto)
const promised = consumeWorkbenchValue(Promise.resolve(dto))
const transportOwned = null as unknown as PromiseLike<DomainDto & Disposable>
const transportDetached = consumeWorkbenchValue(transportOwned)

const detachedType: WorkbenchSnapshot<DomainDto> = detached
const promisedType: Promise<WorkbenchSnapshot<DomainDto>> = promised
const transportDetachedType: Promise<WorkbenchSnapshot<DomainDto>> = transportDetached
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
