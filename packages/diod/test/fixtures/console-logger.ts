import { Logger } from './logger'

export class ConsoleLogger implements Logger {
	public readonly messages: string[] = []
	public info(message: string): void {
		this.messages.push(message)
	}
}
