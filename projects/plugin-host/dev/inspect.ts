import type { DevConsole } from '@pluxel/runtime/dev'

export default function inspect(dev: DevConsole) {
	return dev.plugins.list()
}
