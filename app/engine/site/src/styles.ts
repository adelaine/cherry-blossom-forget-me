import { siteModules } from "./common/module.ts";
import { features } from "./features/index.ts";
import { tools } from "./tools/index.ts";
import { pageStyles } from "./layout/styles.ts";

// Build and development asset generation share the rendered module inventory.
export const siteStyle = pageStyles(siteModules([...features, ...tools]));
