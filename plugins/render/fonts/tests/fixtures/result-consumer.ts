import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	FontsError,
	type FontsPlugin,
	type FontRegistration,
	type FontRegistrationInput,
} from '../../src/index.ts'

export class FontRejected extends TaggedError('FontRejected')<{
	reason: 'invalid_font' | 'too_large'
}> {}

export async function registerBrandFont(
	fonts: FontsPlugin,
	input: FontRegistrationInput,
): Promise<Result<FontRegistration, FontRejected>> {
	try {
		return Result.ok(await fonts.register(input))
	} catch (error) {
		if (error instanceof FontsError && error.code === 'INVALID_FONT') {
			return Result.err(new FontRejected({ reason: 'invalid_font' }))
		}
		if (error instanceof FontsError && error.code === 'FONT_TOO_LARGE') {
			return Result.err(new FontRejected({ reason: 'too_large' }))
		}
		throw error
	}
}
