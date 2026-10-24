import { siteModules } from "./common/module.ts";
import { features } from "./features/index.ts";
import { tools } from "./tools/index.ts";
import { layout, pageHtml } from "./layout/page.ts";
import { pageStyles } from "./layout/styles.ts";
import { pageScript } from "./layout/script.ts";

const modules = siteModules([...features, ...tools]);

export const deploymentPage = {
    html: pageHtml(features, tools),
    style: pageStyles(modules),
    script: pageScript([layout, ...modules]),
};
