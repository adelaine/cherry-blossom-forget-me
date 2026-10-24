import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomBytes } from "node:crypto";

export type SqlRequest = { host: string; account: string; database: string; password: string; sql: string };
export type SqlResult = { state: "succeeded" | "failed"; output: string };

export function validateSqlRequest(input: Record<string, unknown>, config: unknown): SqlRequest {
    const vms = (config as { vms?: { url?: unknown }[] } | null)?.vms;
    if (!Array.isArray(vms) || typeof input.host !== "string" ||
        !vms.some(vm => vm?.url === input.host) ||
        !/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(input.host) || !input.host.endsWith(".netsuite.com")) {
        throw new Error("Select a configured scrumbox with a valid NetSuite hostname.");
    }
    if (typeof input.account !== "string" || !/^[A-Za-z][A-Za-z0-9_$#]*$/.test(input.account.trim())) {
        throw new Error("Enter the database account (Oracle username).");
    }
    if (typeof input.database !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.database.trim())) {
        throw new Error("Enter the database service name.");
    }
    if (typeof input.password !== "string" || !input.password || /[\r\n\0"]/.test(input.password)) {
        throw new Error("Enter a password without line breaks or double quotes.");
    }
    if (typeof input.sql !== "string" || !input.sql.trim() || input.sql.includes("\0") || Buffer.byteLength(input.sql) > 64 * 1024) {
        throw new Error("Enter SQL (maximum 64 KiB).");
    }
    // Prevent an unfinished SQL buffer from consuming the final EXIT command.
    if (!/[;/]\s*$/.test(input.sql)) throw new Error("End SQL statements with a semicolon; end PL/SQL blocks with / on its own line.");
    return { host: input.host, account: input.account.trim(), database: input.database.trim(), password: input.password, sql: input.sql };
}

export function startSql(request: SqlRequest, options: {
    command?: string; args?: string[]; timeoutMs?: number;
} = {}): { child: ChildProcessWithoutNullStreams; result: Promise<SqlResult> } {
    // No shell, credentials in arguments, or on-disk script. Restricted mode
    // disables SQL*Plus HOST, file access, and external scripts.
    const child = spawn(options.command ?? "sqlplus", [...(options.args ?? []), "-L", "-S", "-R", "3", "/nolog"], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, NLS_LANG: ".AL32UTF8" },
    });
    const result = new Promise<SqlResult>(resolve => {
        const limit = 512 * 1024;
        const completed = "SUITECONTAINER_SQL_" + randomBytes(16).toString("hex");
        let output = "", failure = "", truncated = false, sqlError = false, finishedScript = false;
        const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
        const append = (text: string) => {
            const combined = output + text;
            sqlError ||= /^(?:ORA|SP2|TNS)-\d+:/m.test(combined);
            finishedScript ||= combined.split(/\r?\n/).includes(completed);
            let start = Math.max(0, combined.length - limit);
            if (start) {
                truncated = true;
                // Do not expose a password suffix when trimming earlier output.
                const passwordStart = combined.lastIndexOf(request.password, start);
                if (passwordStart >= 0 && passwordStart + request.password.length > start) start = passwordStart + request.password.length;
            }
            output = combined.slice(start);
        };
        child.stdout.on("data", chunk => append(decoders[0].write(chunk)));
        child.stderr.on("data", chunk => append(decoders[1].write(chunk)));
        const timer = setTimeout(() => {
            failure = "SQL execution timed out. The connection was closed; already committed changes remain committed.";
            child.kill("SIGKILL");
        }, options.timeoutMs ?? 60_000);
        child.on("error", error => {
            failure = (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "SQL*Plus is unavailable. Rebuild the container and relaunch the app."
                : "SQL*Plus could not start.";
        });
        child.stdin.on("error", () => { /* A failed login can close input before the script has finished writing. */ });
        child.on("close", code => {
            clearTimeout(timer);
            for (const decoder of decoders) append(decoder.end());
            if (!failure && code === 0 && !finishedScript && !sqlError) failure = "SQL input did not finish. Check statement terminators and end PL/SQL blocks with / on its own line.";
            const failed = !!failure || code !== 0 || sqlError;
            // Redact after assembling output, including passwords split across chunks.
            output = output.split(request.password).join("[redacted]");
            output = output.split(completed).join("");
            if (truncated) output = "[Earlier output omitted; showing the end of the results.]\n" + output;
            if (failure) output += "\n" + failure;
            else if (code !== 0 && !output.trim()) output = "SQL*Plus exited before returning results.";
            resolve({ state: failed ? "failed" : "succeeded", output });
        });
        child.stdin.end([
            "set echo off", "set verify off", "set define off",
            "whenever oserror exit failure rollback", "whenever sqlerror exit failure rollback",
            `connect ${request.account}/"${request.password}"@"//${request.host}:1521/${request.database}"`,
            "set autocommit off", "set sqlblanklines on", "set feedback on", "set heading on",
            "set linesize 200", "set pagesize 1000", "set serveroutput on",
            request.sql, "", `prompt ${completed}`, "exit success rollback", "",
        ].join("\n"));
    });
    return { child, result };
}
