import { runInNewContext } from "node:vm";
import { deploymentPage } from "../src/web-page.ts";

// Instantiate the registered Alpine component and mirror its declared bindings
// onto the small DOM doubles used by the behavioral tests. Real browser tests
// separately verify Alpine's CSP evaluator and the served page together.
export function initializeBrowser(context: any): void {
    let initialize: (() => void) | undefined;
    let component: any;
    const addEventListener = context.document.addEventListener;
    context.document.addEventListener = (event: string, handler: any, options: any) => {
        if (event === "alpine:init") initialize = handler;
        else addEventListener.call(context.document, event, handler, options);
    };
    context.Alpine = { data(_name: string, factory: () => any) { component = factory(); } };
    const pageElements: any[] = [];
    for (const match of deploymentPage.html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const [, tag, attributes, id] = match;
        const element = context.document.getElementById(id);
        element.id = id;
        element.tagName = tag!.toUpperCase();
        element.hidden = /\shidden(?:\s|$)/.test(attributes!);
        element.disabled = /\sdisabled(?:\s|$)/.test(attributes!);
        element.textContent = id === "run-state" ? "Loading…" : "";
        pageElements.push(element);
    }
    const querySelectorAll = context.document.querySelectorAll;
    context.document.querySelectorAll = (selector: string) => selector === "main [id]" ? pageElements : querySelectorAll?.(selector) ?? [];
    const bridge = `
        Object.assign(globalThis, { refresh, heartbeat, render });
        Object.defineProperties(globalThis, {
          state: { get: () => state },
          editing: { get: () => editing, set: value => { editing = value; } },
          credentialEditing: { get: () => credentialEditing, set: value => { credentialEditing = value; } },
        });`;
    runInNewContext(deploymentPage.script.replace("refresh(); setInterval(refresh, 2000);", bridge + "\nrefresh(); setInterval(refresh, 2000);"), context);
    initialize!();
    for (const match of deploymentPage.html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const [, tag, attributes, id] = match;
        const element = context.document.getElementById(id);
        element.id = id;
        element.tagName = tag!.toUpperCase();
        const values = component.view[id!.replaceAll("-", "_")];
        for (const property of ["hidden", "disabled", ...(tag === "p" ? ["textContent"] : [])]) {
            const key = property === "textContent" ? "text" : property;
            Object.defineProperty(element, property, { configurable: true, get: () => values[key], set: value => { values[key] = value; } });
        }
        for (const event of attributes!.matchAll(/@(input|click)="([^"]+)"/g)) {
            element[event[1]!] = () => component[event[2]!].call(component);
        }
    }
    component.init();
}
