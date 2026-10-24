import { credentials } from "./credentials.ts";
import { suiteapps } from "./suiteapps.ts";
import { deployment } from "./deployment.ts";
import { settings } from "./settings.ts";

// Initialize shared settings before their consumers.
export const features = [settings, credentials, suiteapps, deployment];
