# Expo / Hermes 离线安装插件示例

同一个 Android release APK 在三个状态下启动 Pluxel。首次只有共享验收插件；选择一个单独构建的文件后，新的 Hermes runtime 加载 DeviceLanguage；移除文件并重载后，插件从目录消失。React 界面会重新挂载。每次启动产生新的 `runtime` 标识，回执还包含实际插件目录、制品摘要、设备首选语言和共享检查结果。[页面](App.tsx) · [启动与原生服务装配](src/run.ts)

## 构建宿主 A

准备 Android SDK、JDK 和仓库的 Vite+ 工具链。在框架仓库根目录构建 CLI、框架和共享探针，再进入具有独立 lockfile 的 Expo SDK 58 应用。

```sh
vp install --frozen-lockfile
vp run @pluxel/cli#compile
vp run @pluxel-example/host-targets-plugins#compile
cd projects/host-expo
vp install --frozen-lockfile
vp run typecheck
vp run build:android
```

命令生成 `android/app/build/outputs/apk/release/app-release.apk`。Expo prebuild 生成的原生工程位于忽略的 `android/`；本地演示沿用模板的 release 构建和测试签名。Windows 可先运行 `vp run prebuild:android`，在 `android/` 执行 `gradlew.bat :app:assembleRelease`。本例在 JDK 17、Android SDK Platform 37.0 与 36、Build Tools 37.0.0 与 36.0.0、NDK 27.1.12297006 和 CMake 3.22.1 上构建。在 Android 35 x86_64 模拟器验收时，可在生成的 `android/` 中运行 `./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64`。宿主构建时无需生成 DeviceLanguage。只检查 Metro 的 Hermes 字节码可运行 `vp run build:bundle`。

## 安装 B 并重载

1. 在测试设备上安装并打开 A。此时 `catalog` 中只有共享插件，`languages` 为 `null`。
2. 在本目录运行 `vp run build:plugin`，将 `dist/device-language.pluxel.json` 复制到设备的 Downloads。这个文件包含经过 `pluxel build` 处理的插件 JS 和 SHA-256。[插件源码](src/index.ts) · [移动端制品打包](scripts/package-plugin.mjs)
3. 点击 **Install trusted plugin file**，在 Android 文件选择器中选择这份制品。应用检查摘要，把文件保存到自己的持久目录，再用 Expo 的 `reloadAppAsync()` 重载同一个宿主 bundle。新的 `runtime` 和 `DeviceLanguage` 出现在回执中。插件通过 `ctx.service(DeviceLocales)` 读取 Expo Localization 的原生语言标签。断网、退出并重开仍使用这份本地制品。
4. 点击 **Remove plugin and reload**。新 runtime 的目录中再次只有共享插件。要测试另一份制品，修改插件、重新运行 `build:plugin` 并选择新文件即可。

构建器把已编译的插件和它的 JS 依赖打进单个 CommonJS 文件，显式导出 `{ DeviceLanguage, DeviceLocales }`。这样既保留插件类，也保留独立的服务 token。在本例的 Hermes 中，动态执行 esbuild 默认生成的循环 getter 时，两个导出都指向了同一个 token。加载器在安装和启动时检查文件摘要，并向模块提供宿主的 `@pluxel/core` 和 `@pluxel/core/toolchain`，确保插件使用同一套构造器与声明。文件选择是本示例的信任决定。请只选择自己构建或信任的本地制品，它拥有宿主 JS 的执行权限。文件自带的摘要用于检查数据完整性。[本地文件加载器](src/installed-plugin.ts) · [Expo 重载](https://docs.expo.dev/versions/latest/sdk/expo/#reloadappasyncreason)

## Android 设备验收

在 Android 35 英文模拟器或测试设备上使用干净安装。启用 USB 调试，关闭锁屏，在本目录运行以下命令。脚本要求有 Python 3、adb、上面构建的 release APK 以及构建 B 所需的本地开发依赖。

```sh
python3 scripts/check-android.py
```

脚本会检查 APK 内的 Hermes bundle、安装 A、暂时开启飞行模式并读取界面回执，然后在开发机首次构建 B，经 ADB 将文件推入 Downloads，操作系统文件选择器，验证安装、离线冷启动及卸载。它核对每次重载的 runtime 变化、安装和卸载期间的进程 PID、调用结果及最终 APK 摘要，并恢复原有飞行模式。可将 APK 路径作为第一个参数传入；`ADB` 和 `ANDROID_SERIAL` 可指定工具和设备。重复验收前在专用测试设备卸载 `org.pluxel.hostexpo`。[验收脚本](scripts/check-android.py)

## 开发与复制

共享插件可在开发机的 Node/Vite 宿主中用 HMR 联调。Expo UI 用 `vp run start` 和 Metro 调试。发布应用使用本地 bundle，外部插件只在新 JS runtime 启动时加载。每次挂载时，应用启动 Host、借用 SDK 并读取回执，在显示结果前关闭作用域与 Host。共享检查使用进程内 Fetch 传输、会话文件、TinyBase 和只读部署凭据。示例的安装文件单独保存在设备的应用目录。[共享验收](../host-targets/plugins/src/probe.ts) · [宿主开发与发布](../../docs/host/runtime-portability.md)

复制本目录及点文件。源码联调时调整 `package.json` 的 `link:` 与 Metro 的 `watchFolders`；使用安装包时换成同一构建的框架包和共享插件 tarball，并移除指向原 checkout 的 watchFolders。[Metro 配置](metro.config.cjs) · [打包共享插件](../host-targets/README.md#在其他宿主验收内建能力)
