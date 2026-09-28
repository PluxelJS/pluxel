import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { Rates, type RateLimiter } from '../../src/index.ts'

export class MessageRateLimited extends TaggedError('MessageRateLimited')<{
	retryAfterMs: number
	resetAt: number
}> {}

@Plugin()
export class MessagingPlugin extends BasePlugin {
	private messages!: RateLimiter
	private readonly sent: string[] = []

	constructor(private readonly rates: Rates) {
		super()
	}

	protected override init(): void {
		this.messages = this.rates.use('send-message', {
			algorithm: 'sliding-window-counter',
			limit: 100,
			windowMs: 60_000,
		})
	}

	async send(tenantId: string, userId: string): Promise<Result<void, MessageRateLimited>> {
		const decision = await this.messages.consume({ tenantId, userId })
		if (decision.denied) {
			return Result.err(
				new MessageRateLimited({
					retryAfterMs: decision.retryAfterMs,
					resetAt: decision.resetAt,
				}),
			)
		}
		// Replace this example's in-memory delivery with the application's transport.
		this.sent.push(userId)
		return Result.ok(undefined)
	}

	deliveredCount(): number {
		return this.sent.length
	}
}
