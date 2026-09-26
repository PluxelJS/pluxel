import type { PluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { ViteApplicationRecovery } from './internal/vite-application-recovery'

/** One evaluation generation. Acceptance follows Host's catalog PONR, including later lifecycle errors. */
export function beginHostCandidate(options: {
	entry: string
	semantics: Pick<PluginSourceVitePipeline['semantics'], 'beginArtifactGeneration'>
	recovery: ViteApplicationRecovery
}) {
	const generation = options.semantics.beginArtifactGeneration()
	options.recovery.begin(options.entry)
	let state: 'pending' | 'accepted' | 'rejected' = 'pending'
	let failure: ReturnType<ViteApplicationRecovery['failed']> | undefined
	return Object.freeze({
		run<T>(work: () => Promise<T>): Promise<T> {
			if (state !== 'pending') throw new Error('[host-dev] candidate is already settled')
			return generation.run(work)
		},
		async accept(): Promise<void> {
			if (state === 'accepted') return
			if (state !== 'pending') throw new Error('[host-dev] rejected candidate cannot be accepted')
			state = 'accepted'
			generation.commit()
			await options.recovery.committed()
		},
		async reject(): ReturnType<ViteApplicationRecovery['failed']> {
			if (state === 'accepted') return undefined
			if (failure) return failure
			state = 'rejected'
			generation.rollback()
			return (failure = options.recovery.failed())
		},
	})
}
