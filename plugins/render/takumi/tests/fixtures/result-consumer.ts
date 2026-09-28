import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	TakumiError,
	type TakumiPlugin,
	type TakumiRenderInput,
	type TakumiRenderResult,
} from '../../src/index.ts'

export class CardBusy extends TaggedError('CardBusy')<{ message: string }> {}

export async function renderCard(
	takumi: TakumiPlugin,
	input: TakumiRenderInput,
): Promise<Result<TakumiRenderResult, CardBusy>> {
	try {
		return Result.ok(await takumi.render(input))
	} catch (error) {
		if (error instanceof TakumiError && error.code === 'RENDER_BUSY') {
			return Result.err(new CardBusy({ message: 'Card renderer is busy; retry later.' }))
		}
		throw error
	}
}
