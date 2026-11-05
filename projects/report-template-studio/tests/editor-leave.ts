import type { ContentController } from '@worksplit/react'

/** Exercise the controller decision with an owned request cleanup scope. */
export async function decideLeave(controller: ContentController): Promise<boolean> {
	const guard = controller.leave
	if (!guard) return true
	const releases: (() => void)[] = []
	try {
		const result = await guard.decide({
			reason: 'close',
			location: null,
			content: { id: 'test', runEffect: () => () => {} },
			state: guard.getState(),
			signal: new AbortController().signal,
			defer: (cleanup) => releases.push(cleanup),
		})
		return result.decision === 'allow' && result.token === guard.getState().token
	} finally {
		for (const release of releases.toReversed()) release()
	}
}
