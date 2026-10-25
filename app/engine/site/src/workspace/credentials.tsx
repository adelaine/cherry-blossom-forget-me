/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { Icon } from "../common/icon.tsx";
import { useSite } from "../common/runtime.ts";
import {
	errorMessage,
	parseConfiguration,
	targetHost,
} from "../common/state.ts";

type CredentialDraft = {
	authenticationMethod: "browser" | "certificates";
	public: string;
	private: string;
	id: string;
	token: string;
};
type VmDraft = { url: string; account: string };

export const Credentials = () => {
	const runtime = useSite();
	const next = runtime.snapshot;
	const [draft, setDraft] = useState<CredentialDraft>();
	const [changingToken, setChangingToken] = useState(false);
	const [message, setMessage] = useState("");
	const [pending, setPending] = useState("");
	const submitting = useRef(false);
	const request = useRef<AbortController | undefined>(undefined);
	const vmSection = useRef<HTMLDetailsElement>(null);
	const certificatesSection = useRef<HTMLDetailsElement>(null);
	const adminSection = useRef<HTMLDetailsElement>(null);
	const tokenSection = useRef<HTMLDetailsElement>(null);
	const certificateDetails = useRef<HTMLDetailsElement>(null);
	const tokenInput = useRef<HTMLInputElement>(null);
	const download = useRef<
		| {
				url: string;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined
	>(undefined);
	const vmDisplay = useRef<VmDraft>({ url: "", account: "" });
	const vmSource = useRef<string | undefined>(undefined);
	const values: CredentialDraft = draft || {
		authenticationMethod:
			next?.authentication?.method === "certificates"
				? "certificates"
				: "browser",
		public: next?.certificates.public || "",
		private: next?.certificates.private || "",
		id: next?.certificates.id || "",
		token: "",
	};
	const disabled = runtime.disabled || !!pending;
	if (vmSource.current !== runtime.configText) {
		try {
			const vm = (
				parseConfiguration(runtime.configText).vms as
					{ url?: unknown; account?: unknown }[] | undefined
			)?.[0];
			vmDisplay.current = {
				url: typeof vm?.url === "string" ? vm.url : "",
				account: typeof vm?.account === "string" ? vm.account : "",
			};
			vmSource.current = runtime.configText;
		} catch {
			/* Keep the last VM fields while JSON is unfinished. */
		}
	}
	const host = targetHost(runtime.configText);
	const certificateMode = values.authenticationMethod === "certificates";
	const loginRunning = next?.authentication?.state === "running";
	const account = Object.values(next?.authentication?.accounts ?? {}).find(
		(value) =>
			value.url === host && value.account === vmDisplay.current.account,
	);
	const link = (path: string) => (host ? "https://" + host + path : undefined);

	useEffect(
		() => () => {
			request.current?.abort();
			runtime.setPending("credentials", false);
			if (download.current) {
				clearTimeout(download.current.timer);
				URL.revokeObjectURL(download.current.url);
			}
		},
		[],
	);
	useEffect(() => {
		if (!runtime.collapseVersion) return;
		for (const section of [
			vmSection,
			certificatesSection,
			adminSection,
			tokenSection,
		])
			if (section.current) section.current.open = false;
	}, [runtime.collapseVersion]);
	useEffect(() => {
		if (changingToken) tokenInput.current?.focus();
	}, [changingToken]);

	const editVm = (field: keyof VmDraft, value: string) => {
		if (disabled) return;
		runtime.setActionError("");
		try {
			runtime.updateConfig((config) => {
				if (config.vms !== undefined && !Array.isArray(config.vms))
					throw new Error("Invalid VM settings.");
				const vms = (config.vms ??= []) as unknown[];
				vms[0] ??= { account: "000071", url: "" };
				if (!vms[0] || typeof vms[0] !== "object" || Array.isArray(vms[0]))
					throw new Error("Invalid first VM.");
				(vms[0] as Record<string, unknown>)[field] = value.trim();
			});
			vmSource.current = runtime.configText;
			vmDisplay.current = { ...vmDisplay.current, [field]: value };
			setMessage(
				"VM settings changed. Save credentials or settings to keep them.",
			);
		} catch {
			setMessage(
				"Fix the configuration JSON in Advanced configuration before changing the VM.",
			);
		}
	};

	const editCredential = <K extends keyof CredentialDraft>(
		field: K,
		value: CredentialDraft[K],
	) => {
		if (disabled) return;
		setDraft({ ...values, [field]: value });
		runtime.setCredentialEditing(true);
		runtime.setActionError("");
		setMessage("Credentials changed. Click Save credentials before deploying.");
	};

	const perform = async (
		operation: string,
		action: (signal: AbortSignal) => Promise<void>,
	) => {
		if (disabled || submitting.current) return;
		submitting.current = true;
		setPending(operation);
		runtime.setPending("credentials", true);
		runtime.setActionError("");
		const controller = new AbortController();
		request.current = controller;
		try {
			await action(controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) setMessage(errorMessage(error));
		} finally {
			submitting.current = false;
			if (!controller.signal.aborted) setPending("");
			runtime.setPending("credentials", false);
		}
	};

	const save = () => {
		const text = runtime.configText;
		return perform("save", async (signal) => {
			const result = await runtime.api(
				"credentials",
				{ ...values, config: text },
				undefined,
				signal,
			);
			if (signal.aborted) return;
			setDraft(undefined);
			runtime.setCredentialEditing(false);
			setChangingToken(false);
			runtime.saved(result, text);
			setMessage("Credentials and settings saved.");
		});
	};

	const generate = () => {
		if (
			(next?.certificates.hasExisting || runtime.credentialEditing) &&
			!confirm(
				"Generate new certificates? Old certificates saved by this app will not be preserved, and the saved certificate ID will be cleared. Files stored elsewhere are not changed. Register the new public certificate on your scrumbox before deploying.",
			)
		)
			return;
		return perform("generate", async (signal) => {
			const result = await runtime.api(
				"generate",
				{ replace: true },
				undefined,
				signal,
			);
			if (signal.aborted) return;
			const editing = !!values.token.trim();
			setDraft(
				editing
					? {
							...result.certificates,
							token: values.token,
							authenticationMethod: values.authenticationMethod,
						}
					: undefined,
			);
			runtime.setCredentialEditing(editing);
			runtime.accept(result);
			if (certificateDetails.current) certificateDetails.current.open = true;
			setMessage(
				"New certificates saved. Download the public certificate, register it on your scrumbox, then enter the assigned certificate ID and click Save credentials.",
			);
		});
	};

	const downloadCertificate = () => {
		return perform("download", async (signal) => {
			const response = await runtime.request(
				"certificate",
				undefined,
				undefined,
				signal,
			);
			const blob = await response.blob();
			if (signal.aborted) return;
			if (download.current) {
				clearTimeout(download.current.timer);
				URL.revokeObjectURL(download.current.url);
			}
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "public.pem";
			anchor.click();
			download.current = {
				url,
				timer: setTimeout(() => {
					URL.revokeObjectURL(url);
					download.current = undefined;
				}, 1000),
			};
		});
	};

	const signIn = () => {
		const popup = window.open("about:blank", "suitecloud-authentication");
		if (!popup) {
			setMessage(
				"Allow pop-ups for SuiteContainer, then click Sign in with browser again.",
			);
			return;
		}
		popup.opener = null;
		return perform("login", async (signal) => {
			try {
				const text = runtime.configText;
				const saved = await runtime.api(
					"credentials",
					{ ...values, authenticationMethod: "browser", config: text },
					undefined,
					signal,
				);
				runtime.saved(saved, text);
				setDraft(undefined);
				runtime.setCredentialEditing(false);
				const { targets } = await runtime.api<{
					targets: { id: string; account: string; url: string }[];
				}>("targets", undefined, undefined, signal);
				const target = targets.find(
					(value) =>
						value.url === host && value.account === vmDisplay.current.account,
				);
				if (!target)
					throw new Error("Save a VM domain and account before signing in.");
				const result = await runtime.api<{ url: string }>(
					"suitecloud/login",
					{ targetId: target.id },
					undefined,
					signal,
				);
				popup.location.replace(result.url);
				runtime.accept(
					await runtime.api("state", undefined, undefined, signal),
				);
				setMessage("Complete the SuiteCloud sign-in in the browser tab.");
			} catch (error) {
				popup.close();
				throw error;
			}
		});
	};
	const cancelSignIn = async () => {
		try {
			await runtime.api(
				`operations/${next?.authentication.operationId}/cancel`,
				{},
			);
			runtime.accept(await runtime.api("state"));
			setMessage("Sign-in cancelled.");
		} catch (error) {
			setMessage(errorMessage(error));
		}
	};

	return (
		<section id="credentials-section" aria-labelledby="setup-heading">
			<h2 id="setup-heading">
				<Icon name="building-2" /> NS Account
			</h2>
			<article class="credentials-card">
				<ol class="credential-steps" role="list">
					<li>
						<details
							class="setup-section"
							id="vm-section"
							name="ns-account-steps"
							open
							ref={vmSection}
						>
							<summary>
								<span>
									VM<small>Choose your scrumbox</small>
								</span>
							</summary>
							<div class="grid">
								<div>
									<label for="vm">Current VM (scrumbox domain)</label>
									<input
										id="vm"
										aria-describedby="vm-help"
										placeholder="your-scrumbox.vm.eng.netsuite.com"
										disabled={disabled}
										value={vmDisplay.current.url}
										onInput={(event) =>
											editVm("url", event.currentTarget.value)
										}
									/>
								</div>
								<div>
									<label for="vm-account">NetSuite account ID</label>
									<input
										id="vm-account"
										spellcheck={false}
										disabled={disabled}
										value={vmDisplay.current.account}
										onInput={(event) =>
											editVm("account", event.currentTarget.value)
										}
									/>
								</div>
							</div>
							<p id="vm-help">
								<small>
									Enter only the domain, without <code>https://</code>. SQL and
									SFTP use the first configured VM.
								</small>
							</p>
						</details>
					</li>
					<li>
						<details
							class="setup-section"
							id="suitecloud-authentication-section"
							name="ns-account-steps"
							ref={certificatesSection}
						>
							<summary>
								<span>
									SuiteCloud Authentication
									<small>Sign in with your browser or use certificates</small>
								</span>
							</summary>
							<div hidden={certificateMode}>
								<p hidden={account?.connected}>
									Sign in to NetSuite using this browser. Your account and role
									will be saved for future deployments.
								</p>
								<p id="suitecloud-authentication-status" role="status">
									{account?.connected
										? `Signed in to ${account.company} as ${account.role}.`
										: next?.authentication?.error ||
											"Sign in to connect this VM. Sign in again after a SuiteCloud SDK update."}
								</p>
								<button
									id="suitecloud-sign-in"
									disabled={disabled || !host}
									onClick={signIn}
								>
									Sign in with browser
								</button>
								<button
									class="secondary"
									hidden={!loginRunning}
									onClick={cancelSignIn}
								>
									Cancel sign-in
								</button>
							</div>
							<label for="use-certificates">
								<input
									id="use-certificates"
									type="checkbox"
									checked={certificateMode}
									disabled={disabled}
									onChange={(event) =>
										editCredential(
											"authenticationMethod",
											event.currentTarget.checked ? "certificates" : "browser",
										)
									}
								/>
								Use certificates instead
							</label>
							<details id="certificates-section" hidden={!certificateMode}>
								<summary>Certificates</summary>
								<details id="cert-details" ref={certificateDetails}>
									<summary>View certificate paths</summary>
									<p>
										If you have existing certificates, you may override the
										generated certificates. Changing paths requires relaunching.
									</p>
									<label for="public">Public certificate path</label>
									<input
										id="public"
										disabled={disabled}
										value={values.public}
										onInput={(event) =>
											editCredential("public", event.currentTarget.value)
										}
									/>
									<label for="private">Private key path</label>
									<input
										id="private"
										disabled={disabled}
										value={values.private}
										onInput={(event) =>
											editCredential("private", event.currentTarget.value)
										}
									/>
								</details>
								<fieldset class="grid" aria-label="Certificate actions">
									<button
										class="secondary outline"
										id="generate"
										disabled={disabled}
										onClick={generate}
									>
										Generate new certificates
									</button>
									<button
										class="secondary"
										id="download"
										hidden={!next?.certificates.canDownload}
										disabled={disabled}
										onClick={downloadCertificate}
									>
										Download public certificate
									</button>
								</fieldset>
								<p id="cert-message">{next?.certificates.error}</p>
								<div id="registration">
									<p>Register the public certificate on your scrumbox:</p>
									<ol>
										<li>
											Open{" "}
											<strong>
												Setup → Integration → Manage Authentication → OAuth 2.0
												Client Credentials (M2M) Setup
											</strong>
											.
										</li>
										<li>
											Select <strong>SuiteCloud Development Integration</strong>{" "}
											and the appropriate entity and role.
										</li>
										<li>
											Upload <strong>public.pem</strong>.
										</li>
										<li>
											Paste the certificate ID generated by NetSuite below.
										</li>
										<li>
											Enable <strong>Custom Records</strong>.
										</li>
									</ol>
									<nav class="quick-links" aria-label="Certificate setup links">
										<a
											href="https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0422011927.html"
											target="_blank"
											rel="noopener noreferrer"
										>
											NetSuite Guide
										</a>
										<span
											class="scrumbox-links"
											id="scrumbox-links"
											hidden={!host}
										>
											<span>Scrumbox:</span>
											<a
												id="scrumbox-link"
												href={link("/devhome")}
												target="_blank"
												rel="noopener noreferrer"
											>
												Devhome
											</a>
											<a
												id="scrumbox-oauth-link"
												href={link("/app/oauth2/clientcredentials/setup.nl")}
												target="_blank"
												rel="noopener noreferrer"
											>
												OAuth2.0 Client
											</a>
											<a
												id="scrumbox-features-link"
												href={link("/app/setup/features.nl")}
												target="_blank"
												rel="noopener noreferrer"
											>
												Enable Features
											</a>
										</span>
									</nav>
								</div>
								<label for="id">Certificate ID assigned by NetSuite</label>
								<input
									id="id"
									disabled={disabled}
									value={values.id}
									onInput={(event) =>
										editCredential("id", event.currentTarget.value)
									}
								/>
								<p>
									<small>
										This is the ID given by NetSuite when you uploaded the
										certificate.
									</small>
								</p>
							</details>
						</details>
					</li>
					<li>
						<details
							class="setup-section"
							id="admindocs-section"
							name="ns-account-steps"
							ref={adminSection}
						>
							<summary>
								<span>
									AdminDocs
									<small>Configure Features and Preferences</small>
								</span>
							</summary>
							<aside
								class="setup-hint"
								aria-labelledby="bank-connectivity-heading"
							>
								<h3 id="bank-connectivity-heading">
									Bank Connectivity Testing
								</h3>
								<ol>
									<li>
										In <strong>Canary</strong>, enable{" "}
										<code>SUITE_SCRIPT_SFTP_ALLOW_INTERNAL_IPS</code>.
									</li>
									<li>
										In <strong>AdminDocs &gt; Enable Features</strong>, set{" "}
										<q>
											Minimum amount of minutes required between successful FI
											Connectivity imports of the same Format Profile:
										</q>{" "}
										to <code>0</code>.
									</li>
								</ol>
							</aside>
							<nav
								class="quick-links"
								aria-label="Bank Connectivity testing links"
							>
								<span
									class="scrumbox-links"
									id="scrumbox-admin-links"
									hidden={!host}
								>
									<span>Scrumbox:</span>
									<a
										id="scrumbox-admin-devhome-link"
										href={link("/devhome")}
										target="_blank"
										rel="noopener noreferrer"
									>
										Devhome
									</a>
									<a
										id="scrumbox-admin-link"
										href={link("/internal/admin/admin.nl")}
										target="_blank"
										rel="noopener noreferrer"
									>
										AdminDocs
									</a>
									<a
										id="scrumbox-canary-link"
										href={link("/internal/admin/canary/canarydefinition.nl")}
										target="_blank"
										rel="noopener noreferrer"
									>
										Canary
									</a>
								</span>
							</nav>
						</details>
					</li>
					<li>
						<details
							class="setup-section"
							id="token-section"
							name="ns-account-steps"
							ref={tokenSection}
						>
							<summary>
								<span>
									GitLab token
									<small>Used to clone SuiteApps from GitLab</small>
								</span>
							</summary>
							<blockquote class="status-message" id="token-state">
								{next?.tokenPresent
									? "GitLab token saved."
									: "No GitLab token found. SuiteContainer may still be used if you have local copies of SuiteApps."}
							</blockquote>
							<button
								class="secondary outline"
								id="change-token"
								hidden={!next?.tokenPresent || changingToken}
								disabled={disabled}
								onClick={() => setChangingToken(true)}
							>
								Change GitLab token
							</button>
							<div
								id="token-entry"
								hidden={!!next?.tokenPresent && !changingToken}
							>
								<label for="token">GitLab token</label>
								<input
									id="token"
									type="password"
									autocomplete="off"
									placeholder="Paste your token"
									disabled={disabled}
									ref={tokenInput}
									value={values.token}
									onInput={(event) =>
										editCredential("token", event.currentTarget.value)
									}
								/>
							</div>
						</details>
					</li>
				</ol>
				<div class="credentials-footer">
					<fieldset>
						<button id="credentials" disabled={disabled} onClick={save}>
							Save credentials
						</button>
					</fieldset>
					<p id="credential-message" role="status">
						{message}
					</p>
				</div>
			</article>
		</section>
	);
};

export const credentials: SiteModule = {
	id: "credentials",
	placement: "feature",
	slot: "setup",
	Component: Credentials,
	navigation: {
		target: "credentials-section",
		label: "NS Account",
		icon: "building-2",
	},
	styleOrder: 1,
	style: /* css */ `.credential-steps{list-style:none;padding:0;counter-reset:credential-step}
.credential-steps{margin:0}
.credential-steps>li{position:relative;counter-increment:credential-step;padding:1.25rem 1.5rem 1.25rem 4.5rem;margin:0;border-bottom:1px solid var(--pico-muted-border-color)}
.credential-steps>li::before{content:counter(credential-step);position:absolute;inset-inline-start:1.25rem;inset-block-start:1.1rem;display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--pico-secondary-background);color:var(--pico-secondary-inverse);font-weight:500}
.credential-steps>li::after{display:none}
.credential-steps summary small{display:block;margin-top:0.25rem;color:var(--pico-muted-color);font-size:0.8rem;font-weight:300}
.setup-hint{padding:1rem;border-inline-start:3px solid var(--pico-primary);background-color:color-mix(in srgb,var(--pico-primary) 8%,var(--pico-card-background-color));border-radius:0 var(--pico-border-radius) var(--pico-border-radius) 0;margin-bottom:var(--pico-spacing)}
.setup-hint h3{font-size:1rem;margin:0 0 0.75rem}
.setup-hint ol{margin-bottom:0;padding-inline-start:1.25rem}
.setup-hint li{display:list-item;padding:0}
.setup-hint li+li{margin-top:0.75rem}
.setup-hint code{overflow-wrap:anywhere;word-break:break-word}
`,
};
