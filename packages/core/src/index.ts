// index.ts
import "reflect-metadata";
import { PluginManager } from "./core/PluginManager";
import {
  GlobalPluginContext,
  Logger,
  Config,
  EventBus,
} from "./core/GlobalContext";
import { PluginA } from "./plugins/PluginA";
import { PluginB } from "./plugins/PluginB";
import { PluginC } from "./plugins/PluginC";

// 构造简单的 Logger、Config、EventBus（占位实现）
const logger: Logger = {
  info: console.log,
  error: console.error,
};

const config: Config = {
  get: (key: string) => null,
};

const eventBus: EventBus = {
  // 占位实现
};

const globalContext: GlobalPluginContext = {
  logger,
  config,
  eventBus,
};

const pluginManager = new PluginManager(globalContext);

// 注册插件，假设 PluginA 必需依赖 PluginB
// 如果缺少必需依赖（例如未注册 PluginB），PluginA 将因解析失败而不加载
pluginManager.registerPlugin(PluginB);
// pluginManager.registerPlugin(PluginC); // PluginC 为可选依赖，可注册也可不注册
pluginManager.registerPlugin(PluginA);

// 提交本周期，构建 diod 容器后依次初始化插件
try {
  const container = pluginManager.commit();
  container.get(PluginB).doSomething();
  container.get(PluginA).doSomething();
} catch (error) {
  console.error("Failed to commit plugins:", error);
}
