import { ansiToHtml, applyAnsiColors } from "../common/ansi.ts";
import { browserModule, type SiteModule } from "../common/module.ts";
import { apiScript } from "../common/api.ts";
import { runtimeScript } from "../common/runtime.ts";

export function pageScript(modules: readonly SiteModule[]): string {
    return `const ansiToHtml = ${ansiToHtml.toString()};
const applyAnsiColors = ${applyAnsiColors.toString()};
document.addEventListener('alpine:init', () => {
${runtimeScript}
${apiScript}
${modules.map(browserModule).join("\n")}
  Alpine.data('deployment', () => {
    const runtime = createSiteRuntime();
    Object.assign(runtime.context, createSiteApi(runtime.context));
    for (const module of siteFactories) runtime.add(module);
    Object.defineProperties(runtime.controller, {
      $runtime: {value:runtime.context},
      init: {value:function() { runtime.start(this); }},
      destroy: {value:function() { runtime.dispose(); }},
    });
    return runtime.controller;
  });
});`;
}
