# Dynamic host 的 package manager

`@pluxel/runtime-dynamic` 本身不下载 package。需要在运行中的开发 host 安装/删除 registry 插件时，装配官方
`@pluxel/package-manager`：

```ts
import { PackageManagerPlugin } from '@pluxel/package-manager'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	plugins: [PackageManagerPlugin],
	sources: [
		{
			kind: 'directory',
			path: '.pluxel/managed-plugins/entries',
			include: ['*.mjs'],
		},
	],
	runtimeState: { snapshot: { enabled: ['PackageManagerPlugin'] } },
	workbench: { enabled: true, access: { exposure: 'private' } },
})
```

启动后可以从 Workbench 的 Package Manager 页面操作，或由宿主 command carrier 调用：

```text
package.install { "specs": ["@scope/plugin@^2.0.0"] }
package.remove  { "specs": ["@scope/plugin"] }
```

安装成功表示 package 已进入受管 pnpm project 并发布为 dynamic source，不表示插件已启用。启停继续使用 RuntimeState、
Workbench plugin status 或 `plugin.start` / `plugin.stop` commands。这样 package acquisition failure、代码加载 failure 与
lifecycle failure 保持可区分。

Package Manager 只能在声明了对应 `rootDir/entries` directory source 和 `['*.mjs']` include 的 dynamic host 中运行。校验在
native pnpm engine 与所有文件/UI/command 副作用之前完成；因此把它放入 static catalog 或写错 source path 会直接得到可分支的
`DYNAMIC_SOURCE_REQUIRED` / `DYNAMIC_SOURCE_NOT_DECLARED` 启动错误。

默认不执行 dependency scripts，并拒绝发布未满一天的版本。确实需要 native build 时，由宿主为
`PackageManagerPlugin` 同时设置 `ignoreScripts: false` 和非空 exact `allowBuilds`；矛盾配置会拒绝启动，不会退化成全局开放
scripts。registry credential 仍放在 pnpm 配置，不会进入
Workbench contract 或日志。

安装输入只接受小写 registry package name 加 version/range/dist-tag，例如 `@scope/plugin@^2.0.0` 或
`@scope/plugin@latest`。npm alias、`file:`、URL、Git 和本地目录均会在调用 native engine 前拒绝。

managed root 默认是 `.pluxel/managed-plugins`。不要手工编辑其中的 `package.json`、lockfile、`node_modules` 或
`entries/`；本地源码直接声明为 dynamic `file`/`directory` source，不要伪装成 registry package。
