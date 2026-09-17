import type { DevConsole } from '@pluxel/host-dev/console'

export default function inspect(dev: DevConsole) {
	return dev.plugins.list()
}
