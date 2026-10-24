export interface SiteModule {
    id: string;
    placement: "feature" | "tool";
    slot?: "setup" | "suiteapps" | "settings" | "deployment";
    html: string;
    style?: string;
    styleOrder?: number;
    script: string;
    navigation?: { target: string; label: string };
}

// Bindings come from the contribution that owns the elements. An omitted module
// contributes no DOM lookups or Alpine handlers to the assembled controller.
export function browserModule(module: SiteModule): string {
    const ids = [...module.html.matchAll(/\bid="([^"]+)"/g)].map(
        (match) => match[1],
    );
    const events = [...module.html.matchAll(/@(input|click|change)="([^"]+)"/g)]
        .map((match) => [match[1], match[2]]);
    return `registerSiteModule(${JSON.stringify(module.id)}, ${JSON.stringify({ ids, events })}, ${module.script});`;
}

export function siteModules(modules: readonly SiteModule[]): readonly SiteModule[] {
    const ids = new Set<string>();
    for (const module of modules) {
        if (ids.has(module.id)) throw new Error(`Duplicate site module: ${module.id}`);
        ids.add(module.id);
    }
    return modules;
}
