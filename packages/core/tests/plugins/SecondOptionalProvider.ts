import { BasePlugin, Plugin } from '@pluxel/core/internal/test'

let nextGeneration = 0

export function resetSecondOptionalProvider(): void {
	nextGeneration = 0
}

@Plugin({ displayName: 'Second optional provider' })
export class SecondOptionalProvider extends BasePlugin {
	readonly generation = ++nextGeneration
}
