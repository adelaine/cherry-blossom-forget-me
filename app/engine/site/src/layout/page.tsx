/** @jsxImportSource preact */
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { SiteProvider, SiteRuntime, useSite } from "../common/runtime.ts";
import { errorMessage, parseConfiguration } from "../common/state.ts";
import { modules } from "../modules.ts";
import { Icon } from "../common/icon.tsx";

const Appearance = () => {
	const runtime = useSite();
	const [selectedTheme, setSelectedTheme] = useState<string>();
	const [systemDark, setSystemDark] = useState(false);
	const [brand, setBrand] = useState("netsuite-2026");
	const [message, setMessage] = useState("");
	const saving = useRef<AbortController | undefined>(undefined);
	const theme = selectedTheme || runtime.snapshot?.theme;
	const dark = theme === "dark" || (theme !== "light" && systemDark);

	useEffect(() => {
		const media = matchMedia("(prefers-color-scheme: dark)");
		const update = () => setSystemDark(media.matches);
		update();
		media.addEventListener("change", update);
		const choice = sessionStorage.getItem("suitecontainer-brand-theme");
		if (
			choice === "default" ||
			choice === "oracle-corporate-2026" ||
			choice === "netsuite-2026"
		)
			setBrand(choice);
		return () => {
			media.removeEventListener("change", update);
			saving.current?.abort();
		};
	}, []);
	useLayoutEffect(() => {
		if (theme === "light" || theme === "dark")
			document.documentElement.dataset.theme = theme;
		else delete document.documentElement.dataset.theme;
	}, [theme]);
	useEffect(() => {
		const stylesheet = document.getElementById(
			"brand-theme-stylesheet",
		) as HTMLLinkElement | null;
		if (!stylesheet) return;
		stylesheet.media = brand === "default" ? "not all" : "all";
		if (brand !== "default") stylesheet.href = "/themes/" + brand + ".css";
	}, [brand]);

	const changeTheme = async (checked: boolean) => {
		if (runtime.stopped || runtime.connectionFailed) return;
		const next = checked ? "dark" : "light";
		setSelectedTheme(next);
		setMessage("");
		saving.current?.abort();
		const controller = (saving.current = new AbortController());
		try {
			const config = parseConfiguration(runtime.configText);
			if (
				config.status === undefined ||
				(config.status &&
					typeof config.status === "object" &&
					!Array.isArray(config.status))
			) {
				runtime.themeDraft(next);
			}
		} catch {
			/* Preserve unfinished configuration. */
		}
		try {
			await runtime.api("theme", { theme: next }, undefined, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) setMessage(errorMessage(error));
		}
	};
	return (
		<>
			<div class="theme-controls">
				<label class="brand-theme-picker" for="brand-theme-select">
					<select
						id="brand-theme-select"
						aria-label="Appearance"
						value={brand}
						onChange={(event) => {
							const choice = event.currentTarget.value;
							setBrand(choice);
							sessionStorage.setItem("suitecontainer-brand-theme", choice);
						}}
					>
						<option value="default">Default</option>
						<option value="netsuite-2026">NetSuite 2026</option>
						<option value="oracle-corporate-2026">Oracle Corporate 2026</option>
					</select>
				</label>
				<label class="theme-toggle" for="theme-toggle">
					<input
						id="theme-toggle"
						type="checkbox"
						role="switch"
						aria-label="Dark theme"
						checked={dark}
						disabled={runtime.stopped || runtime.connectionFailed}
						onChange={(event) => void changeTheme(event.currentTarget.checked)}
					/>
				</label>
			</div>
			<p id="theme-message" role="status">
				{message}
			</p>
		</>
	);
};

const Contributions = ({ items }: { items: readonly SiteModule[] }) => {
	return (
		<>
			{items.map(({ id, Component }) => (
				<Component key={id} />
			))}
		</>
	);
};

export const Page = ({
	inventory = modules,
}: {
	inventory?: readonly SiteModule[];
}) => {
	const runtime = useSite();
	const slot = (name: SiteModule["slot"]) =>
		inventory.filter(
			(module) =>
				module.placement === "feature" && (module.slot ?? "setup") === name,
		);
	const panels = [
		{ id: "setup", items: slot("setup") },
		{ id: "suiteapps", items: slot("suiteapps") },
		{
			id: "deployment",
			items: [...slot("deployment"), ...slot("settings")],
		},
		...inventory
			.filter((module) => module.placement === "tool")
			.map((module) => ({ id: module.id, items: [module] })),
	].filter((panel) => panel.items.length);
	const [selectedPanel, setSelectedPanel] = useState("setup");
	const activePanel = panels.some((panel) => panel.id === selectedPanel)
		? selectedPanel
		: panels[0]?.id;
	useLayoutEffect(() => {
		const tool = inventory.find(
			(module) => module.placement === "tool" && module.id === activePanel,
		);
		const target =
			tool?.navigation && document.getElementById(tool.navigation.target);
		if (target instanceof HTMLDetailsElement) target.open = true;
	}, [activePanel, inventory]);
	return (
		<main class="container">
			<header class="app-header">
				<hgroup>
					<h1>
						<mark>SuiteContainer</mark>
					</h1>
					<p>
						Set your scrumbox address, complete your credentials, then deploy
						your SuiteApps.
					</p>
				</hgroup>
				<Appearance />
			</header>
			<nav class="section-nav" aria-label="SuiteContainer">
				{panels.map((panel) => {
					const navigation = panel.items.find(
						(module) => module.navigation,
					)?.navigation;
					return (
						navigation && (
							<a
								key={panel.id}
								href={"#" + navigation.target}
								aria-current={activePanel === panel.id ? "page" : undefined}
								onClick={(event) => {
									event.preventDefault();
									setSelectedPanel(panel.id);
									const target = document.getElementById(navigation.target);
									if (target instanceof HTMLDetailsElement) target.open = true;
								}}
							>
								{navigation.icon && <Icon name={navigation.icon} />}
								{navigation.label}
							</a>
						)
					);
				})}
				<button id="help" type="button" class="nav-help">
					<Icon name="circle-help" />
					Help
				</button>
				<button
					id="stop"
					disabled={
						!runtime.snapshot ||
						runtime.preventStop ||
						runtime.stopped ||
						runtime.connectionFailed ||
						runtime.pending.has("stop")
					}
					onClick={() => void runtime.stop()}
				>
					Stop app
				</button>
			</nav>
			<p id="connection-error" role="alert" hidden={!runtime.connectionFailed}>
				{runtime.connectionFailed ? runtime.connectionMessage : ""}
			</p>
			<p
				id="app-message"
				role="status"
				hidden={
					activePanel === "deployment" ||
					!(runtime.stopMessage || runtime.actionError)
				}
			>
				{runtime.stopMessage || runtime.actionError}
			</p>
			<div class="subpanels">
				{panels.map((panel) => (
					<div
						key={panel.id}
						id={panel.id + "-panel"}
						class="subpanel"
						hidden={activePanel !== panel.id}
					>
						{panel.id === "suiteapps" ? (
							<section
								id="suiteapps-section"
								aria-labelledby="suiteapps-heading"
							>
								<Contributions items={panel.items} />
							</section>
						) : (
							<Contributions items={panel.items} />
						)}
					</div>
				))}
			</div>
		</main>
	);
};

export const App = ({
	runtime,
	inventory,
}: {
	runtime: SiteRuntime;
	inventory?: readonly SiteModule[];
}) => {
	return (
		<SiteProvider runtime={runtime}>
			<Page inventory={inventory} />
		</SiteProvider>
	);
};
