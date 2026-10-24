/** @jsxImportSource preact */
import { render } from "preact";
import { App } from "./layout/page.tsx";
import { SiteRuntime } from "./common/runtime.ts";

const root = document.getElementById("app");
if (!root) throw new Error("Application root is missing.");
render(<App runtime={new SiteRuntime()} />, root);
window.addEventListener("pagehide", () => render(null, root), { once: true });
