import type { ChatCommandContext, ChatCommandMiddleware } from './types.ts'

/** Koa-style composition with a guard against executing downstream work twice. */
export function runCommandMiddleware(
	context: ChatCommandContext,
	middlewares: readonly ChatCommandMiddleware[],
	execute: () => unknown | Promise<unknown>,
): Promise<unknown> {
	let furthest = -1
	const dispatch = async (index: number): Promise<unknown> => {
		if (index <= furthest) throw new Error('Command middleware next() called multiple times')
		furthest = index
		const middleware = middlewares[index]
		return middleware ? middleware(context, () => dispatch(index + 1)) : execute()
	}
	return dispatch(0)
}
