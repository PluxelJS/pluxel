import { BasePlugin, Plugin } from '@pluxel/core'

export abstract class DeviceLocales {
	abstract languageTags(): string[]
}

@Plugin()
export class DeviceLanguage extends BasePlugin {
	read() {
		const languages = this.ctx.service(DeviceLocales).languageTags()
		if (!languages[0]) throw new Error('The device did not report a preferred language')
		return languages
	}
}
