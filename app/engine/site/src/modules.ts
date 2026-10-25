import { siteModules } from "./common/module.ts";
import { workspace } from "./workspace/index.ts";
import { tools } from "./tools/index.ts";

export const modules = siteModules([...workspace, ...tools]);

export const moduleStyles = modules
	.filter((module) => module.style)
	.slice()
	.sort((left, right) => (left.styleOrder ?? 0) - (right.styleOrder ?? 0))
	.map((module) => module.style)
	.join("\n");
