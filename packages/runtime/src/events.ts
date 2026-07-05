// Type-level bridge for runtime public event contracts.
//
// Why:
// - Plugin authors augment `@pluxel/runtime`, not `@pluxel/context`.
// - The canonical event registry still lives in `@pluxel/core/services`.
// - `RuntimeEvents` keeps the augmentation surface flat, which is easier for TS tooling
//   and avoids namespace-export bugs in the current dts bundler.

export interface RuntimeEvents {}

declare module '@pluxel/core' {
	interface Events extends RuntimeEvents {}
}
