/* Copyright (c) 2026, Oracle and/or its affiliates. */
import type { Auth } from "./auth.ts";

export interface SuiteApp {
	url?: string;
	directory: string;
	branch?: string;
	localPath?: string;
}
export interface Vm {
	account: string;
	url: string;
	database?: { user?: string; service?: string };
}

export interface SuiteAppDeployment extends Vm {
	type: "suiteapp-deployed";
	suiteapp: string;
}
export type Config = {
	suiteapps: SuiteApp[];
	certificates?: { public: string; private: string; id: string };
	authentication?: Auth["suitecloud-authentication"];
	vms: Vm[];
	status?: { "deploy-start-ok"?: 0 | 1; theme?: "light" | "dark" };
};
