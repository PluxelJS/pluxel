// 空文件，只是用于测试它的加载速度
import { BasePlugin, Plugin } from '@pluxel/hmr'
export function add(a: number, b: number): number {
	return a + b
}
add(1, 2)
