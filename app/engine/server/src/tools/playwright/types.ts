/* Copyright (c) 2026, Oracle and/or its affiliates. */
export type PlaywrightBrowser = "container" | "local-chrome";
export interface PlaywrightSettings {
	enabled: boolean;
	project: string;
	browser?: PlaywrightBrowser;
	testFile?: string;
	workers?: number;
}
