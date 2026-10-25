import { createHash, randomUUID } from "node:crypto";
import { ServiceError, structuredError, errorStatus } from "./errors.ts";
import type { LogRedactionState } from "./context.ts";

export type OperationState =
	"preparing" | "running" | "succeeded" | "failed" | "cancelled";
export interface Operation {
	id: string;
	instanceId: string;
	kind: string;
	targets: string[];
	state: OperationState;
	created: string;
	started?: string;
	finished?: string;
	cancelSupported: boolean;
	result?: unknown;
	error?: ReturnType<typeof structuredError>;
}
type StoredOperation = Operation & {
	log: string;
	offset: number;
	sourceLength: number;
	logState: LogRedactionState;
	cancel?: () => Promise<void>;
};
type Reply = { status: number; value: unknown };

const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
};

export class OperationsService {
	readonly instanceId: string;
	private records = new Map<string, StoredOperation>();
	private requests = new Map<
		string,
		{
			fingerprint: string;
			pending?: Promise<Reply>;
			outcome?: Reply;
			operationId?: string;
		}
	>();
	private retainedRequests: string[] = [];
	restartPending = "";
	private redact: (text: string, active?: boolean) => string;
	private activity: () => void;
	private sanitize?: (
		state: LogRedactionState,
		chunk: string,
		final?: boolean,
	) => string;
	constructor(
		instanceId: string = randomUUID(),
		redact: (text: string, active?: boolean) => string = (text) => text,
		activity: () => void = () => {},
		sanitize?: (
			state: LogRedactionState,
			chunk: string,
			final?: boolean,
		) => string,
	) {
		this.redact = redact;
		this.activity = activity;
		this.sanitize = sanitize;
		this.instanceId = instanceId;
	}
	busy(): boolean {
		return [...this.records.values()].some(
			(op) => op.state === "preparing" || op.state === "running",
		);
	}
	assertIdle(): void {
		if (this.restartPending)
			throw new ServiceError(
				"service_restart_pending",
				this.restartPending,
				409,
				true,
			);
		const active = [...this.records.values()].find(
			(op) => op.state === "preparing" || op.state === "running",
		);
		if (active)
			throw new ServiceError(
				"operation_conflict",
				`${active.kind === "playwright" ? "Playwright tests are" : active.kind === "sql" ? "SQL is" : "Deployment is"} running. Wait for its results before making changes.`,
				409,
				true,
				{ operationId: active.id, kind: active.kind },
			);
	}
	reserve(
		kind: string,
		targets: string[],
		cancel?: () => Promise<void>,
	): Operation {
		this.assertIdle();
		const op: StoredOperation = {
			id: `${this.instanceId}.${randomUUID()}`,
			instanceId: this.instanceId,
			kind,
			targets,
			state: "preparing",
			created: new Date().toISOString(),
			cancelSupported: !!cancel,
			log: "",
			offset: 0,
			sourceLength: 0,
			logState: { pending: "", privateKey: false },
			cancel,
		};
		this.records.set(op.id, op);
		return this.get(op.id);
	}
	running(id: string): void {
		const op = this.lookup(id);
		op.state = "running";
		op.started = new Date().toISOString();
	}
	finish(
		id: string,
		result: unknown,
		state: "succeeded" | "failed" | "cancelled" = "succeeded",
	): void {
		const op = this.lookup(id);
		if (op.finished) return;
		this.writeLog(op, this.sanitize?.(op.logState, "", true) ?? "");
		op.state = state;
		op.result = result;
		op.finished = new Date().toISOString();
		this.activity();
		this.prune();
	}
	fail(id: string, error: unknown): void {
		const op = this.lookup(id);
		if (op.finished) return;
		this.writeLog(op, this.sanitize?.(op.logState, "", true) ?? "");
		op.state = "failed";
		op.error = structuredError(error, this.redact);
		op.finished = new Date().toISOString();
		this.activity();
		this.prune();
	}
	append(id: string, text: string): void {
		const op = this.lookup(id);
		op.sourceLength += text.length;
		this.writeLog(
			op,
			this.sanitize
				? this.sanitize(op.logState, text)
				: this.redact(text, true),
		);
	}
	replaceLog(id: string, text: string): void {
		const op = this.lookup(id);
		if (text.length > op.sourceLength)
			this.append(id, text.slice(op.sourceLength));
	}
	private writeLog(op: StoredOperation, text: string): void {
		const bytes = Buffer.from(op.log + text);
		let removed = Math.max(0, bytes.length - 512 * 1024);
		while (removed < bytes.length && (bytes[removed] & 0xc0) === 0x80)
			removed++;
		op.log = bytes.subarray(removed).toString("utf8");
		op.offset += removed;
	}
	get(id: string): Operation {
		const {
			log: _log,
			offset: _offset,
			sourceLength: _sourceLength,
			logState: _logState,
			cancel: _cancel,
			...op
		} = this.lookup(id);
		return structuredClone(op);
	}
	list(): Operation[] {
		return [...this.records.keys()].map((id) => this.get(id));
	}
	logs(id: string, cursor = "0") {
		if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
			throw new ServiceError(
				"invalid_cursor",
				"The log cursor must be a nonnegative integer.",
			);
		const op = this.lookup(id);
		const bytes = Buffer.from(op.log);
		const position = Number(cursor);
		let start = Math.max(0, position - op.offset);
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		return {
			id,
			instanceId: this.instanceId,
			log: bytes.subarray(start).toString("utf8"),
			nextCursor: String(op.offset + bytes.length),
			truncated: position < op.offset,
		};
	}
	async cancel(id: string): Promise<Operation> {
		const op = this.lookup(id);
		if (!op.cancelSupported || !op.cancel)
			throw new ServiceError(
				"cancellation_unsupported",
				"This operation cannot safely be cancelled.",
				409,
			);
		if (!op.finished) {
			await op.cancel();
			this.finish(id, { cancelled: true }, "cancelled");
		}
		return this.get(id);
	}
	async idempotent(
		key: string | undefined,
		action: string,
		input: unknown,
		execute: () => Promise<Reply> | Reply,
	): Promise<Reply> {
		if (!key) return execute();
		if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key))
			throw new ServiceError(
				"invalid_idempotency_key",
				"Idempotency-Key must be 1 to 200 printable non-space ASCII characters.",
			);
		const fingerprint = createHash("sha256")
			.update(canonical({ action, input }))
			.digest("hex");
		const existing = this.requests.get(key);
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw new ServiceError(
					"idempotency_conflict",
					"This Idempotency-Key was already used for different input.",
					409,
				);
			if (existing.pending) return existing.pending;
			if (existing.operationId) {
				const operation = this.records.get(existing.operationId);
				if (!operation)
					throw new ServiceError(
						"idempotency_expired",
						"The original operation is outside retained history. Its request will not be replayed.",
						410,
					);
				return {
					status: 202,
					value: {
						instanceId: this.instanceId,
						operationId: operation.id,
						operation: this.get(operation.id),
					},
				};
			}
			if (existing.outcome) return existing.outcome;
			throw new ServiceError(
				"idempotency_expired",
				"The original request outcome is outside retained history. Its request will not be replayed.",
				410,
			);
		}
		// Record before invoking execution, including asynchronous preparation.
		const record: {
			fingerprint: string;
			pending?: Promise<Reply>;
			outcome?: Reply;
			operationId?: string;
		} = { fingerprint };
		const result = Promise.resolve()
			.then(execute)
			.catch((error) => ({
				status: errorStatus(error),
				value: structuredError(error, this.redact),
			}))
			.then((reply) => {
				const value =
					reply.value && typeof reply.value === "object"
						? (reply.value as Record<string, unknown>)
						: {};
				if (typeof value.operationId === "string")
					record.operationId = value.operationId;
				else {
					// Preserve the original safe response until the bounded retry history expires.
					record.outcome = reply;
					this.retainedRequests.push(key);
					while (this.retainedRequests.length > 100) {
						const expired = this.retainedRequests.shift()!;
						const entry = this.requests.get(expired);
						if (entry) entry.outcome = undefined;
					}
				}
				record.pending = undefined;
				return reply;
			});
		record.pending = result;
		this.requests.set(key, record);
		return result;
	}
	private lookup(id: string): StoredOperation {
		const op = this.records.get(id);
		if (op) return op;
		if (
			/^[0-9a-f-]+\.[0-9a-f-]+$/i.test(id) &&
			!id.startsWith(this.instanceId + ".")
		)
			throw new ServiceError(
				"operation_lost",
				"This operation belonged to a previous backend instance. Rediscover the instance; do not replay uncertain mutations.",
				410,
			);
		throw new ServiceError("operation_not_found", "Operation not found.", 404);
	}
	private prune(): void {
		const completed = [...this.records.values()].filter((op) => op.finished);
		for (const op of completed.slice(0, Math.max(0, completed.length - 100)))
			this.records.delete(op.id);
		// Retry records retain outcomes for the lifetime of the instance.
	}
}
