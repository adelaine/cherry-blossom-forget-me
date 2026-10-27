/* Copyright (c) 2026, Oracle and/or its affiliates. */
export type PlaywrightBrowser = "container" | "local-chrome";

/** Inputs supplied for one test run, independent of saved workspace settings. */
export interface PlaywrightRun {
	project: string;
	host: string;
	account: string;
	testFile?: string;
	workers?: number;
}
