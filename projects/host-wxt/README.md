# 净链 · WXT 浏览器扩展

净链随 Chromium 扩展发行两条清理规则。打开工具栏弹窗可预览当前 URL，也可以右键预览网页链接。「读取网页规范链接」通过本次操作授予的 `activeTab` 权限读取 `<link rel="canonical">`。

打开「规则设置」，用同页的测试链接观察启停、配置修改和恢复默认后的结果。完整操作见[固定插件的启停与配置](../../docs/host/fixed-plugins.md)。

## 运行

从框架仓库根目录运行，WXT 会查找本机 Chromium 并加载开发版扩展。

```sh
vp install --frozen-lockfile
vp run @pluxel-example/host-wxt#dev
```

浏览器在宿主机、WXT 在容器时，可以在本目录创建本机专用的 `web-ext.config.ts`，然后运行同一条命令。在 Chromium 的 `chrome://extensions` 开启开发者模式，加载 `projects/host-wxt/.output/chrome-mv3-dev`。

```ts
import { defineWebExtConfig } from 'wxt'

export default defineWebExtConfig({ disabled: true })
```

## 项目接线

清理页和设置页各持有一个 Host，在页面关闭时释放。两页通过 `browser.storage.local` 同步开关。每个 Host 用 `HostDocumentStorage` 将配置写入同一份浏览器存储，订阅外部修改。设置页用插件 schema 生成表单并按编辑版本提交。[应用装配](src/application.ts) · [开关](src/preferences.ts) · [配置存储](src/config-storage.ts) · [表单](entrypoints/options/management.ts)

开发中可以把 UTM 规则里的 `/^utm_/i` 改成 `/^(utm_|ref$)/i`。保持设置页打开并启用该规则，默认测试链接结果中的 `ref` 会消失。WXT 编译固定清单的插件，页面在 `host.updateCatalog()` 提交时切换到新代码。[WXT 模块](modules/pluxel.ts) · [插件清单](src/catalog.ts)

## 验证与打包

在本目录运行。Chromium 回归构建发行扩展，离线验证实际工具栏、配置冲突、多页同步和重开恢复，再在隔离的开发目录检查同页 HMR、其他规则实例保留和失败恢复。[浏览器回归](scripts/smoke.mjs)

```sh
vp run check-types
vp run check-tests
vp exec playwright install --no-shell chromium
vp run check-smoke
vp run zip
```

可加载的发行目录和分发 ZIP 均生成在 `.output/`。
