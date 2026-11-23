import { BasePlugin, Plugin } from '@pluxel/core'

export abstract class DesktopApp {
	abstract getName(): string
	abstract getVersion(): string
}

@Plugin()
export class DesktopInfo extends BasePlugin {
	inspect() {
		const desktop = this.ctx.service(DesktopApp)
		return { name: desktop.getName(), version: desktop.getVersion() }
	}
}
