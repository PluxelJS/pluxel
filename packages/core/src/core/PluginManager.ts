// PluginManager.ts
import { GlobalPluginContext } from "./GlobalContext";
import { BasePlugin } from "./PluginBase";
import { createScopedContext } from "./ScopedContext";
import {
  PLUGIN_META_KEY,
  PluginMetadata,
  OPTIONAL_PARAMS_KEY,
} from "./PluginDecorator";
import { ContainerBuilder, Newable, Container } from "diod";
import { ExtendedDIContainer, DIContainer } from "./ExtendedDIContainer";

export class PluginManager {
  private pluginClasses: Newable<BasePlugin>[] = [];
  private containerBuilder: ContainerBuilder;
  private diContainer!: DIContainer;
  private loadedPlugins: BasePlugin[] = [];

  constructor(private globalCtx: GlobalPluginContext) {
    this.containerBuilder = new ContainerBuilder();
  }

  /**
   * 注册插件时，将插件类通过 diod 的 builder 注册，
   * factory 中利用构造函数参数类型和 Optional 装饰器解析依赖，
   * 若必需依赖缺失则捕获异常并返回 null，从而在后续 commit 时跳过该插件。
   */
  public registerPlugin(PluginClass: Newable<BasePlugin>): void {
    const meta = Reflect.getMetadata(
      PLUGIN_META_KEY,
      PluginClass
    ) as PluginMetadata;
    if (!meta) {
      throw new Error(
        "Plugin metadata is missing. Ensure @Plugin decorator is applied."
      );
    }
    this.globalCtx.logger.info(
      `Registering plugin: ${meta.name} [${meta.type}]`
    );

    // 利用 diod 的注册接口
    this.containerBuilder
      .register(PluginClass)
      .useFactory((c) => {
        const paramTypes: any[] =
          Reflect.getMetadata("design:paramtypes", PluginClass) || [];
        this.globalCtx.logger.info(
          `Param types for ${PluginClass.name}: ${paramTypes
            .map((t) => t.name)
            .join(", ")}`
        );
        const optionalParams: number[] =
          Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, PluginClass) || [];
        try {
          const dependencies = paramTypes.map((depType, index) => {
            if (optionalParams.includes(index)) {
              try {
                // 对可选依赖，若解析失败则返回 undefined
                return c.get(depType);
              } catch (e) {
                return undefined;
              }
            } else {
              // 对必需依赖，若解析结果为 undefined，则主动抛出错误
              const dep = c.get(depType);
              if (dep === undefined) {
                throw new Error(
                  `Missing required dependency for parameter index ${index}`
                );
              }
              return dep;
            }
          });
          return new PluginClass(...dependencies);
        } catch (error) {
          // 必需依赖缺失时，记录错误并返回 null（表示该插件加载失败）
          this.globalCtx.logger.error(
            `Failed to instantiate plugin ${meta.name}: ${error.message}`
          );
          return null;
        }
      })
      .asSingleton();

    // 记录插件类以便后续从容器中解析
    this.pluginClasses.push(PluginClass);
  }

  /**
   * 提交当前周期的插件注册，构建 diod 容器，并依次解析各插件实例，
   * 对于实例不为 null 的插件注入 ScopedContext 并调用 init。
   */
  public commit(): Container {
    let container: Container;
    try {
      container = this.containerBuilder.build(); // 采用 autowire（自动注入）
    } catch (error) {
      this.globalCtx.logger.error("Container build failed:", error);
      throw error;
    }
    this.diContainer = new ExtendedDIContainer(container);

    for (const PluginClass of this.pluginClasses) {
      try {
        const instance = this.diContainer.get(PluginClass);
        if (instance) {
          const scopedCtx = createScopedContext(this.globalCtx);
          instance.setContext(scopedCtx);
          instance.init();
          this.loadedPlugins.push(instance);
        }
      } catch (error) {
        const meta = Reflect.getMetadata(
          PLUGIN_META_KEY,
          PluginClass
        ) as PluginMetadata;
        this.globalCtx.logger.error(
          `Plugin ${meta.name} failed to load at commit: ${error.message}`
        );
      }
    }

    return container;
  }

  // 卸载指定插件
  public unloadPlugin(PluginClass: Function): void {
    const index = this.loadedPlugins.findIndex(
      (plugin) => plugin.constructor === PluginClass
    );
    if (index >= 0) {
      const plugin = this.loadedPlugins[index];
      plugin.dispose();
      const meta = Reflect.getMetadata(
        PLUGIN_META_KEY,
        PluginClass
      ) as PluginMetadata;
      this.globalCtx.logger.info(`Unloaded plugin: ${meta?.name}`);
      this.loadedPlugins.splice(index, 1);
    }
  }

  public unloadAll(): void {
    for (const plugin of this.loadedPlugins) {
      plugin.dispose();
    }
    this.loadedPlugins = [];
  }
}
