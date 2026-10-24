/** @jsxImportSource preact */
import { useEffect, useRef } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { useSite } from "../common/runtime.ts";
import { errorMessage } from "../common/state.ts";

export function Settings() {
    const runtime = useSite();
    const details = useRef<HTMLDetailsElement>(null);
    const request = useRef<AbortController | undefined>(undefined);
    const submitting = useRef(false);
    useEffect(
        () => () => {
            request.current?.abort();
            runtime.setPending("settings", false);
        },
        [],
    );
    useEffect(() => {
        if (runtime.collapseVersion && details.current)
            details.current.open = false;
    }, [runtime.collapseVersion]);

    async function save() {
        if (runtime.disabled || submitting.current) return;
        submitting.current = true;
        runtime.setPending("settings", true);
        runtime.setActionError("");
        const controller = new AbortController();
        request.current = controller;
        const text = runtime.configText;
        try {
            const next = await runtime.api(
                "settings",
                { config: text },
                undefined,
                controller.signal,
            );
            if (!controller.signal.aborted) runtime.saved(next, text);
        } catch (error) {
            if (!controller.signal.aborted)
                runtime.setSettingsMessage(errorMessage(error));
        } finally {
            submitting.current = false;
            runtime.setPending("settings", false);
        }
    }

    return (
        <article>
            <details class="setup-section" id="settings-section" ref={details}>
                <summary>
                    <h2>Advanced configuration</h2>
                </summary>
                <div class="advanced-configuration-art">
                    <img
                        src="/advanced-configuration.png"
                        alt="Three dragon heads labeled Auto-Deploy, Supporting Tools, and Configuration, with a playful Configuration head."
                        width="1158"
                        height="1338"
                        loading="lazy"
                    />
                </div>
                <div class="advanced-configuration-intro">
                    <p>
                        Edit local checkout paths, custom directories, and other
                        options here. Additional scrumboxes may be entered under{" "}
                        <code>vms</code>. SQL and SFTP use settings from the
                        first entry.
                    </p>
                </div>
                <label for="config">Configuration JSON</label>
                <textarea
                    id="config"
                    spellcheck={false}
                    rows={22}
                    value={runtime.configText}
                    disabled={runtime.disabled}
                    onInput={(event) =>
                        runtime.changeConfig(event.currentTarget.value)
                    }
                />
                <fieldset>
                    <button
                        id="save"
                        disabled={
                            runtime.disabled || runtime.pending.has("settings")
                        }
                        onClick={save}
                    >
                        Save settings
                    </button>
                </fieldset>
                <p id="settings-message" role="status">
                    {runtime.settingsMessage}
                </p>
            </details>
        </article>
    );
}

export const settings: SiteModule = {
    id: "settings",
    placement: "feature",
    slot: "settings",
    Component: Settings,
    styleOrder: 5,
    style: /* css */ `#settings-section{position:relative}
.advanced-configuration-art{display:none;height:auto}
#settings-section[open]>.advanced-configuration-art{display:block;position:absolute;inset-block-start:-0.5rem;inset-inline-end:0;width:14rem;max-width:100%;overflow:hidden;max-height:10rem}
#settings-section[open]>summary{padding-inline-end:16rem}
.advanced-configuration-intro{padding-inline-end:16rem;}
@media(max-width:575px){#settings-section[open]>summary{padding-inline-end:0}#settings-section[open]>.advanced-configuration-art{position:static;width:14rem;margin:0 auto 1.5rem}.advanced-configuration-intro{padding-inline-end:0;min-height:0}}
`,
};
