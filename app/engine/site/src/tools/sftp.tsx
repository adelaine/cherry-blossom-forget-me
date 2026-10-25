/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { Icon } from "../common/icon.tsx";
import { useSite } from "../common/runtime.ts";
import { errorMessage } from "../common/state.ts";

type SftpDraft = {
	username: string;
	port: string;
	path: string;
	password: string;
};
type CopyField = "url" | "key" | "user" | "port";

export const Sftp = () => {
	const runtime = useSite();
	const status = runtime.snapshot?.sftp;
	const remote = status && "mode" in status ? status : undefined;
	const [draft, setDraft] = useState<SftpDraft>();
	const [requestError, setRequestError] = useState("");
	const [notice, setNotice] = useState("");
	const [copyMessage, setCopyMessage] = useState("");
	const [copied, setCopied] = useState<Partial<Record<CopyField, boolean>>>({});
	const request = useRef<AbortController | undefined>(undefined);
	const submitting = useRef(false);
	const mounted = useRef(true);
	const copyTimers = useRef(
		new Map<CopyField, ReturnType<typeof setTimeout>>(),
	);
	const probedTarget = useRef("");
	const details = useRef<HTMLDetailsElement>(null);
	const fields = draft ?? {
		username: status?.username || "",
		port: String(status?.port ?? ""),
		path: status?.path || "",
		password: "",
	};
	const active = remote
		? remote.state === "starting" || remote.probe === "checking"
		: status?.state === "starting" || status?.state === "running";
	const unavailable =
		runtime.stopped ||
		runtime.connectionFailed ||
		!status ||
		submitting.current;
	const disabled = unavailable || active;
	const connection = remote ? remote.connection : status;
	const values: Record<CopyField, string> = {
		url: remote && !connection ? "" : "localhost",
		key: connection?.hostKey || "",
		user: connection?.username || "",
		port: connection ? String(connection.port) : "",
	};
	const statusText = remote
		? remote.probe === "checking"
			? "Checking target SSH access…"
			: remote.state === "starting"
				? "SFTP operation is in progress…"
				: remote.connection
					? "SFTP access verified."
					: remote.probe === "ready" && remote.state !== "failed"
						? "Target SSH access verified. Click Start SFTP to check SFTP access."
						: remote.probe === "idle"
							? "Waiting to check target SSH access…"
							: "SFTP access could not be verified."
		: status
			? {
					stopped: "SFTP is stopped.",
					starting: "SFTP is starting…",
					running: "SFTP is running.",
					failed: "SFTP failed.",
				}[status.state]
			: "Loading SFTP settings…";
	const tunnel = remote ? undefined : status?.tunnel;
	const tunnelMessage = remote
		? ""
		: tunnel?.error ||
			(tunnel?.state === "starting"
				? "Connecting the scrumbox tunnel…"
				: status?.state === "running" && tunnel?.state !== "running"
					? "The scrumbox tunnel is not connected."
					: "");
	const message = [
		statusText,
		requestError ||
			status?.error ||
			notice ||
			(draft
				? "SFTP settings changed. Save settings or click Start SFTP."
				: ""),
		tunnelMessage,
		status?.relaunch
			? "Relaunch required. Stop the app and start the launcher again to mount the selected folder."
			: "",
	]
		.filter(Boolean)
		.join(" ");
	const probeTarget = remote?.target || "";

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			request.current?.abort();
			for (const timer of copyTimers.current.values()) clearTimeout(timer);
			runtime.setPending("sftp", false);
		};
	}, [runtime]);
	useEffect(() => {
		if (runtime.collapseVersion && details.current)
			details.current.open = false;
	}, [runtime.collapseVersion]);
	useEffect(() => {
		if (
			!remote ||
			!probeTarget ||
			probedTarget.current === probeTarget ||
			runtime.stopped ||
			runtime.connectionFailed
		)
			return;
		probedTarget.current = probeTarget;
		if (remote.probe !== "idle") return;
		const controller = new AbortController();
		// The mounted page owns this probe, while the backend owns its SSH work.
		const timer = setTimeout(() => {
			void runtime
				.api("sftp", { action: "probe" }, undefined, controller.signal)
				.then((next) => {
					const current = runtime.snapshot?.sftp;
					if (
						!controller.signal.aborted &&
						current &&
						"target" in current &&
						current.target === probeTarget
					)
						runtime.accept(next);
				})
				.catch((error) => {
					if (!controller.signal.aborted) setRequestError(errorMessage(error));
				});
		}, 0);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [probeTarget, runtime, runtime.stopped, runtime.connectionFailed]);

	const edit = (changes: Partial<SftpDraft>) => {
		if (disabled) return;
		setDraft({ ...fields, ...changes });
		setRequestError("");
		setNotice("");
	};

	const act = async (operation: "start" | "stop" | "save" | "recreate") => {
		if (submitting.current || unavailable || (operation !== "stop" && active))
			return;
		if (
			operation === "start" &&
			(status?.relaunch || (remote && !remote.canStart))
		)
			return;
		if (
			operation === "stop" &&
			(remote
				? !remote.canStop
				: !active &&
					!["starting", "running"].includes(status?.tunnel.state || ""))
		)
			return;
		if (
			operation === "recreate" &&
			(!remote?.recreateAvailable ||
				!confirm(
					"Recreate the target SFTP container with these credentials? This replaces the existing container named sftp and discards files inside it.",
				))
		)
			return;
		submitting.current = true;
		setRequestError("");
		setNotice("");
		runtime.setPending("sftp", true);
		const controller = new AbortController();
		request.current = controller;
		try {
			const data =
				operation === "stop"
					? { action: operation }
					: {
							action: operation,
							confirmReplace: operation === "recreate",
							username: fields.username.trim(),
							port: Number(fields.port),
							path: fields.path.trim(),
							...(fields.password ? { password: fields.password } : {}),
						};
			const next = await runtime.api(
				"sftp",
				data,
				undefined,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			if (operation !== "stop") setDraft(undefined);
			setNotice(operation === "save" ? "SFTP settings saved." : "");
			runtime.accept(next);
		} catch (error) {
			if (!controller.signal.aborted) setRequestError(errorMessage(error));
		} finally {
			submitting.current = false;
			runtime.setPending("sftp", false);
		}
	};

	const copy = async (field: CopyField) => {
		setCopyMessage("");
		try {
			await navigator.clipboard.writeText(values[field]);
			if (!mounted.current) return;
			setCopied((previous) => ({ ...previous, [field]: true }));
			clearTimeout(copyTimers.current.get(field));
			copyTimers.current.set(
				field,
				setTimeout(() => {
					copyTimers.current.delete(field);
					setCopied((previous) => ({ ...previous, [field]: false }));
				}, 1500),
			);
		} catch {
			if (mounted.current)
				setCopyMessage(
					"Could not copy. Select the value and copy it manually.",
				);
		}
	};

	return (
		<article>
			<details class="setup-section" id="sftp-section" ref={details}>
				<summary>
					<h2>
						<Icon name="wrench" /> SFTP file sharing
					</h2>
				</summary>
				<p id="sftp-description">
					{remote
						? "Run SFTP on the deployment target and upload files directly to it."
						: "Enable file sharing from your laptop. 🌐 Requires SSH connectivity to scrumbox"}
				</p>
				<fieldset class="grid" aria-label="SFTP actions">
					<button
						id="sftp-start"
						disabled={
							disabled || status?.relaunch || (!!remote && !remote.canStart)
						}
						onClick={() => act("start")}
					>
						Start SFTP
					</button>
					<button
						id="sftp-stop"
						class="secondary outline"
						disabled={
							unavailable ||
							(remote
								? !remote.canStop
								: !active &&
									!["starting", "running"].includes(status?.tunnel.state || ""))
						}
						onClick={() => act("stop")}
					>
						Stop SFTP
					</button>
					<button
						id="sftp-save"
						class="secondary"
						disabled={disabled}
						onClick={() => act("save")}
					>
						Save settings
					</button>
				</fieldset>
				<button
					id="sftp-recreate"
					hidden={!remote?.recreateAvailable}
					disabled={disabled}
					onClick={() => act("recreate")}
				>
					Recreate SFTP
				</button>
				<blockquote class="status-message" id="sftp-message" role="status">
					{message}
				</blockquote>
				<p id="sftp-upload" hidden={!remote?.uploadUrl}>
					Upload files directly to{" "}
					<strong id="sftp-upload-url">{remote?.uploadUrl || ""}</strong>.
				</p>
				<details>
					<summary>SFTP settings</summary>
					<p>These are your own machine settings.</p>
					<div class="grid">
						<div>
							<label for="sftp-user">User</label>
							<input
								id="sftp-user"
								autocomplete="off"
								spellcheck={false}
								disabled={disabled}
								value={fields.username}
								onInput={(event) =>
									edit({
										username: event.currentTarget.value,
									})
								}
							/>
						</div>
						<div>
							<label for="sftp-port">Port</label>
							<input
								id="sftp-port"
								type="number"
								min="1024"
								max="65535"
								step="1"
								disabled={disabled}
								value={fields.port}
								onInput={(event) => edit({ port: event.currentTarget.value })}
							/>
						</div>
					</div>
					<div class="grid">
						<div>
							<label for="sftp-password">Password</label>
							<input
								id="sftp-password"
								type="password"
								autocomplete="new-password"
								aria-describedby="sftp-password-help"
								disabled={disabled}
								value={fields.password}
								onInput={(event) =>
									edit({
										password: event.currentTarget.value,
									})
								}
							/>
							<p
								id="sftp-password-help"
								class={status?.passwordPresent ? "status-message" : undefined}
							>
								{status?.passwordPresent
									? "A password is saved. Leave blank to use saved password."
									: "Enter a password before starting SFTP."}
							</p>
						</div>
						<div id="sftp-folder" hidden={!!remote}>
							<label for="sftp-path">Absolute path to local folder</label>
							<input
								id="sftp-path"
								spellcheck={false}
								aria-describedby="sftp-path-help"
								disabled={disabled}
								value={fields.path}
								onInput={(event) => edit({ path: event.currentTarget.value })}
							/>
							<p id="sftp-path-help">
								Leave blank to use the default folder{" "}
								<strong>sftp-files</strong>. Changing this value requires a
								restart.
							</p>
						</div>
					</div>
				</details>
				<details>
					<summary>NetSuite connection fields</summary>
					<p>
						Use these settings for the connectivity plugin in{" "}
						<strong>NetSuite &gt; Format Profile</strong>. Note: Internal SFTP
						addresses must be allowed on the deployment scrumbox via{" "}
						<strong>AdminDocs Canary Tool</strong>.
					</p>
					<div class="grid sftp-connection-grid">
						<div>
							<div class="sftp-value-heading">
								<span id="sftp-url-label">URL</span>
								<button
									id="copy-sftp-url"
									type="button"
									class="secondary outline"
									aria-label="Copy URL"
									disabled={
										!values.url || runtime.connectionFailed || runtime.stopped
									}
									onClick={() => copy("url")}
								>
									{copied.url ? "Copied" : "Copy"}
								</button>
							</div>
							<div
								id="sftp-netsuite-url"
								class="sftp-connection-value"
								tabindex={0}
								aria-labelledby="sftp-url-label"
							>
								{values.url}
							</div>
						</div>
						<div class="sftp-connection-key">
							<div class="sftp-value-heading">
								<span id="sftp-key-label">Host key</span>
								<button
									id="copy-sftp-key"
									type="button"
									class="secondary outline"
									aria-label="Copy host key"
									disabled={
										!values.key || runtime.connectionFailed || runtime.stopped
									}
									onClick={() => copy("key")}
								>
									{copied.key ? "Copied" : "Copy"}
								</button>
							</div>
							<div
								id="sftp-host-key"
								class="sftp-connection-value"
								tabindex={0}
								aria-labelledby="sftp-key-label"
							>
								{values.key}
							</div>
						</div>
						<div class="sftp-connection-user">
							<div class="sftp-value-heading">
								<span id="sftp-user-label">Username</span>
								<button
									id="copy-sftp-user"
									type="button"
									class="secondary outline"
									aria-label="Copy username"
									disabled={
										!values.user || runtime.connectionFailed || runtime.stopped
									}
									onClick={() => copy("user")}
								>
									{copied.user ? "Copied" : "Copy"}
								</button>
							</div>
							<div
								id="sftp-netsuite-user"
								class="sftp-connection-value"
								tabindex={0}
								aria-labelledby="sftp-user-label"
							>
								{values.user}
							</div>
						</div>
						<div class="sftp-connection-port">
							<div class="sftp-value-heading">
								<span id="sftp-port-label">Port</span>
								<button
									id="copy-sftp-port"
									type="button"
									class="secondary outline"
									aria-label="Copy port"
									disabled={
										!values.port || runtime.connectionFailed || runtime.stopped
									}
									onClick={() => copy("port")}
								>
									{copied.port ? "Copied" : "Copy"}
								</button>
							</div>
							<div
								id="sftp-netsuite-port"
								class="sftp-connection-value"
								tabindex={0}
								aria-labelledby="sftp-port-label"
							>
								{values.port}
							</div>
						</div>
						<div class="sftp-connection-password">
							<div class="sftp-value-heading">
								<span id="sftp-password-label">Password</span>
							</div>
							<div
								id="sftp-netsuite-password"
								class="sftp-connection-value"
								tabindex={0}
								aria-labelledby="sftp-password-label"
							>
								use the password saved above
							</div>
						</div>
					</div>
					<p id="sftp-copy-message" role="status">
						{copyMessage}
					</p>
				</details>
			</details>
		</article>
	);
};

export const sftp: SiteModule = {
	id: "sftp",
	placement: "tool",
	Component: Sftp,
	navigation: { target: "sftp-section", label: "SFTP", icon: "wrench" },
	styleOrder: 7,
	style: /* css */ `.sftp-connection-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.sftp-connection-grid>div{min-width:0}
.sftp-connection-key{grid-column:2;grid-row:1/span 2;display:flex;flex-direction:column}
.sftp-value-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--pico-spacing);min-height:calc(var(--pico-spacing)*2);margin-bottom:calc(var(--pico-spacing)*0.375)}
.sftp-value-heading button{--pico-form-element-spacing-vertical:calc(var(--pico-spacing)*0.125);--pico-form-element-spacing-horizontal:calc(var(--pico-spacing)*0.75);margin:0;font-size:0.8em}
.sftp-connection-value{padding:var(--pico-form-element-spacing-vertical) var(--pico-form-element-spacing-horizontal);border:var(--pico-border-width) solid var(--pico-form-element-border-color);border-radius:var(--pico-border-radius);background:var(--pico-form-element-background-color);color:var(--pico-form-element-color);opacity:var(--pico-form-element-disabled-opacity);cursor:text;overflow-wrap:anywhere}
.sftp-connection-key .sftp-connection-value{flex:1;min-height:0;max-height:calc(var(--pico-spacing)*12);overflow:auto;font-family:var(--pico-font-family-monospace)}
.sftp-connection-user{grid-column:1;grid-row:2}
.sftp-connection-port{grid-column:2;grid-row:3}
.sftp-connection-password{grid-column:1;grid-row:3}
`,
};
