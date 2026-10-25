/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { Hono } from "hono";
import type { ServerLifecycle } from "../main.ts";
import { assetsApi } from "./assets.ts";
import {
	publicMiddleware,
	authenticatedMiddleware,
	errorHandlers,
} from "./middleware.ts";
import { systemApi, healthApi } from "./system.ts";
import { operationsApi, type ApiApp } from "./operations.ts";
import { credentialsApi } from "./credentials.ts";
import { suiteappsApi } from "./suiteapps.ts";
import { deploymentApi } from "./deployment.ts";
import { sqlApi } from "./sql.ts";
import { sftpApi } from "./sftp.ts";
import { playwrightApi } from "./playwright.ts";

/** Compose the externally callable API and its middleware in request order. */
export function createApplication(lifecycle: ServerLifecycle): ApiApp {
	const app: ApiApp = new Hono();
	publicMiddleware(app, lifecycle);
	assetsApi(app, lifecycle);
	healthApi(app, lifecycle);
	authenticatedMiddleware(app, lifecycle);
	systemApi(app, lifecycle);
	credentialsApi(app, lifecycle);
	suiteappsApi(app, lifecycle);
	deploymentApi(app, lifecycle);
	sqlApi(app, lifecycle);
	sftpApi(app, lifecycle);
	playwrightApi(app, lifecycle);
	operationsApi(app, lifecycle);
	errorHandlers(app, lifecycle);
	return app;
}
