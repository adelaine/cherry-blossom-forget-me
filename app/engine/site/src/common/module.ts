import type { ComponentType } from "preact";

export interface SiteModule {
	id: string;
	placement: "feature" | "tool";
	slot?: "setup" | "suiteapps" | "settings" | "deployment";
	Component: ComponentType;
	style?: string;
	styleOrder?: number;
	navigation?: { target: string; label: string };
}

export const siteModules = (
	modules: readonly SiteModule[],
): readonly SiteModule[] => {
	const ids = new Set<string>();
	for (const module of modules) {
		if (ids.has(module.id))
			throw new Error(`Duplicate site module: ${module.id}`);
		ids.add(module.id);
	}
	return modules;
};
