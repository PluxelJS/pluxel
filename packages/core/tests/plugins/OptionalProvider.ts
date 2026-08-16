import { BasePlugin, Plugin } from '@pluxel/core/test'

let shouldFail = false
let nextGeneration = 0

export function resetOptionalProvider(): void {
	shouldFail = false
	nextGeneration = 0
}

export function setOptionalProviderFailure(value: boolean): void {
	shouldFail = value
}

@Plugin({ displayName: 'Optional provider' })
export class OptionalProvider extends BasePlugin {
	readonly generation = ++nextGeneration

	override init(): void {
		if (shouldFail) throw new Error('optional provider failed')
	}
}
