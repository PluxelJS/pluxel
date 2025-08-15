import { Service } from '../../src/utils/decorators'

@Service()
export class Clock {
	public readonly rand = Math.random()

	public now(): string {
		const currentDate = new Date()

		return `${currentDate.getMinutes()}:${currentDate.getSeconds()}`
	}
}
