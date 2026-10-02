export const ACTIVITY_GRACE_MS = 15 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 30 * 1000;

export class HeartbeatDeadline {
    private lastHeartbeat: number;
    private now: () => number;
    constructor(now: () => number = () => performance.now()) {
        this.now = now;
        this.lastHeartbeat = now();
    }
    heartbeat(): void { this.lastHeartbeat = this.now(); }
    expired(busy: boolean): boolean {
        if (busy) {
            this.heartbeat();
            return false;
        }
        return this.now() - this.lastHeartbeat >= ACTIVITY_GRACE_MS;
    }
}
