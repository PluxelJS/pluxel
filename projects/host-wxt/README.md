# 净链 · WXT 浏览器扩展

净链是一个 Chromium Manifest V3 扩展。打开网页后点击工具栏按钮，可以清理当前 URL、查看哪些规则改动了链接，再复制结果。例如，默认规则会把 `https://example.org/guide?lang=zh&utm_source=mail#setup` 清理成 `https://example.org/guide?lang=zh#setup`。

- 在网页链接上右键选择「使用净链清理链接」，会在独立扩展页中预览目标链接。也可以直接在弹窗粘贴链接。
- 点击「读取网页规范链接」，扩展会读取当前文档的 `<link rel="canonical">` 并重新预览。网页访问使用本次工具栏操作授予的 `activeTab` 权限。
- 「规则设置」打开浏览器的扩展选项页。每张卡片可以启停规则，并编辑该规则的参数。UTM 清理默认开启，页内锚点规则默认停用。

## 用一个参数验证完整链路

1. 粘贴 `https://example.org/guide?ref=mail&utm_source=feed#setup`。默认结果保留 `ref=mail`。
2. 打开「规则设置」，在 UTM 规则的「额外移除的参数」填写 `ref` 并保存。已打开的预览立即变为 `https://example.org/guide#setup`。
3. 将参数改为 `ref fbclid` 并保存。表单会显示插件 schema 的校验消息，保留草稿，清理页仍使用上一次有效配置。点击「恢复插件默认配置」会清除该规则的保存值。
4. 停用 UTM 规则，原始 URL 中的追踪参数会重新出现。启用锚点规则后，普通段落锚点被移除；「同时移除哈希路由」控制 `#/settings` 等应用内路径。

设置页从已接纳的 `host.catalog()` 读取插件配置声明，由 `valibot-form/web` 的 AutoForm 渲染。提交时用表单库的 `buildEditableConfigPatch` 比较草稿与已保存的输入，再调用带编辑版本的 `host.config.patch/reset`。Host 校验、保存并通知插件的 `configs.onUpdate()`。多个设置页同时编辑时，过期草稿可以重新载入最新配置。 [表单管理](entrypoints/options/management.ts) · [配置编辑器](entrypoints/options/ConfigEditor.tsx)

`HostDocumentStorage` 把 Host 生成的配置文档持久化到 `browser.storage.local`；页面订阅文档变更，Host 负责验证并采用新配置。启停意图按规则单独保存，各页面分别通过 `setAutoStart` 同步启动策略、通过 `startNode/stopNode` 更新当前会话。设置页和清理页各自的 Host 都随页面关闭释放，后台 service worker 只处理浏览器菜单事件。 [存储适配](src/config-storage.ts) · [规则实现](src/tracking.ts)

## 开发与热替换

开发时可在仓库中查询插件的声明、配置和依赖。查询在开发机读取源码，扩展选项页只提供链接清理规则的设置。 [查询插件结构与依赖](../../docs/development/inspection.md#结构与依赖)

从仓库根目录启动 WXT。默认 runner 会查找本机 Chromium 并加载开发版扩展。

```sh
vp install --frozen-lockfile
vp run @pluxel-example/host-wxt#dev
```

若浏览器位于宿主机、开发服务位于容器中，可在示例目录创建本机专用的 `web-ext.config.ts`，再运行同一条开发命令。在 Chromium 的 `chrome://extensions` 开启开发者模式，加载 `projects/host-wxt/.output/chrome-mv3-dev`。

```ts
import { defineWebExtConfig } from 'wxt'

export default defineWebExtConfig({ disabled: true })
```

观察插件 HMR 时，使用右键菜单或将 `chrome-extension://<扩展 ID>/popup.html` 打开为标签页，这样切回编辑器时页面仍然存活。粘贴含 `ref=mail&utm_source=mail` 的链接并保持 UTM 规则开启。在 `src/tracking.ts` 中把 `/^utm_/i` 改为 `/^(utm_|ref$)/i` 并保存。结果中的 `ref` 会立即消失，输入草稿和其他运行中的规则实例会保留。 [UTM 插件](src/tracking.ts)

## 扩展各部分由谁负责

| 入口                                                                        | 职责                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WXT 配置](wxt.config.ts)                                                   | WXT 从 `entrypoints/` 发现后台、内容脚本、弹窗和选项页，生成 MV3 清单与扩展路径类型。React 模块负责设置页，Auto Icons 从同一 SVG 生成图标。                                                                 |
| [后台 service worker](entrypoints/background.ts)                            | 安装链接右键菜单，将选中的 URL 放进扩展页的 URL 片段。后台按浏览器事件唤醒。                                                                                                                                |
| [内容脚本](entrypoints/canonical.content.ts)                                | 用户请求规范链接时，由 `scripting.executeScript` 注入当前网页并返回结果。发行清单无需申请常驻站点权限。                                                                                                     |
| [弹窗](entrypoints/popup/main.ts) 与 [设置页](entrypoints/options/main.tsx) | 弹窗负责读取标签页、预览和复制。设置页根据插件声明渲染 AutoForm，显示规则的实际启停结果。                                                                                                                   |
| [本地 WXT 模块](modules/pluxel.ts)                                          | WXT 自动加载 `modules/`。模块在 WXT 的 Vite 开发与构建钩子中挂载 `pluginModules`，编译 client 环境的 Pluxel 声明。                                                                                          |
| [Pluxel 应用](src/application.ts) 与 [静态目录](src/catalog.ts)             | 每个清理页和设置页各有一个 embedded Host。扩展为每个 Host 提供一个 `LinkCleaner`。清理页与规则通过 `ctx.service(LinkCleaner)` 取得同一实例。规则在启动时注册清理函数，停用时撤销注册。页面关闭时释放 Host。 |

插件代码随扩展一起打包。Vite 接受静态目录的源码更新，页面通过 `host.updateCatalog()` 提交新构造器。规则参数可独立保存；停用时保存的参数在下次启用时采用。开发时修改 manifest、后台或 HTML 入口仍遵循 WXT 本身的重载策略。 [WXT 模块](https://wxt.dev/guide/essentials/wxt-modules) · [WXT 开发模式](https://wxt.dev/guide/resources/how-wxt-works#dev-mode)

## 验证与打包

在示例目录运行以下命令。类型检查使用 `wxt prepare` 生成的类型；单元测试通过官方 `WxtVitest()` 插件使用扩展 API 测试环境。

```sh
cd projects/host-wxt
vp run check-types
vp run check-tests
vp exec playwright install --no-shell chromium
vp run check-smoke
vp run zip
```

回归先通过 WXT 构建生产扩展，逐个检查 JavaScript 产物的模块清单，确认 Workbench 和管理服务均未进入发行包。Chromium 加载同一份产物，离线验证工具栏、按需内容脚本、设置同步与持久化，并在独立开发目录中验证同一页面的插件热替换、其他实例保留和失败恢复。可解压加载的目录与分发 ZIP 均生成在 `.output/`。 [测试配置](vitest.config.ts) · [Chromium 回归](scripts/smoke.mjs) · [跨平台宿主契约](../../docs/host/runtime-portability.md)
