export class ServiceError extends Error {
    public code: string;
    public details: Record<string, unknown>;
    public status: number;
    public retryable: boolean;
    constructor(
        code: string,
        message: string,
        status = 400,
        retryable = false,
        details: Record<string, unknown> = {},
    ) {
        super(message);
        this.code = code;
        this.details = details;
        this.status = status;
        this.retryable = retryable;
    }
}

export const isServiceError = (error: unknown): error is ServiceError => {
    return (
        error instanceof Error &&
        typeof (error as ServiceError).code === "string" &&
        typeof (error as ServiceError).status === "number" &&
        typeof (error as ServiceError).retryable === "boolean"
    );
};
export const errorStatus = (error: unknown): number => {
    return isServiceError(error)
        ? error.status
        : error && typeof error === "object" && "code" in error
          ? 500
          : 400;
};

export const message = (error: unknown): string => {
    const text = (
        error instanceof Error ? error.message : String(error)
    ).replace(/ Update .* and run the start script again\.$/, "");
    if (text === "credentials/auth.json needs the NetSuite certificate ID.")
        return "Enter a valid Certificate ID assigned by NetSuite in Credentials and click Save credentials.";
    if (text === "VM 1 needs an account ID and a NetSuite domain.")
        return "Enter your deployment scrumbox domain in Current VM, without https:// or /devhome. Check the first VM's account ID in Settings.";
    if (
        text ===
        "Certificate files were not mounted. Check their paths in credentials/auth.json."
    )
        return "Cannot find both certificate files. Check Certificate paths in Credentials and relaunch if needed, or use Generate certificates to create a new pair.";
    if (
        text ===
        "The public and private certificate files do not match or cannot be read."
    )
        return "The certificate files do not match or cannot be read. Check Certificate paths in Credentials, or generate and register a new pair.";
    return text;
};

export const structuredError = (
    error: unknown,
    redact: (text: string) => string,
) => {
    return {
        error:
            error instanceof SyntaxError
                ? "Invalid JSON."
                : redact(message(error)),
        code: isServiceError(error)
            ? error.code
            : errorStatus(error) === 500
              ? "internal_error"
              : error instanceof SyntaxError
                ? "invalid_json"
                : "invalid_request",
        retryable: isServiceError(error) ? error.retryable : false,
        details: isServiceError(error) ? error.details : {},
    };
};
