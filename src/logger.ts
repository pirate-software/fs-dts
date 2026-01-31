export abstract class Logger {
    abstract debug(...data: any[]): void;
    abstract log(...data: any[]): void;
    abstract warn(...data: any[]): void;
    abstract error(...data: any[]): void;
}

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

export class DiscordLogger extends Logger {
    private readonly webhookUrl: string | null;
    private webhookQueue: string[] = [];
    private currentMessage: string = '';
    private currentMessageLevel: LogLevel = LogLevel.INFO;
    private webhookTimer: NodeJS.Timeout | null = null;
    private queueTimer: NodeJS.Timeout | null = null;

    private readonly maxChars: number;
    private readonly inactivityMs: number;
    private readonly infoPreamble: string;
    private readonly warnPreamble: string
    private readonly errorPreamble: string;

    private readonly consoleLogLevel: LogLevel;
    private readonly webhookLogLevel: LogLevel;

    constructor(
        webhookUrl: string | null,
        infoPreamble: string,
        warnPreamble: string,
        errorPreamble: string,
        maxChars = 1000,
        inactivityMs = 10000,
        consoleLogLevel = LogLevel.DEBUG,
        webhookLogLevel = LogLevel.INFO
    ) {
        super();
        this.webhookUrl = webhookUrl;
        this.maxChars = maxChars;
        this.inactivityMs = inactivityMs;
        this.infoPreamble = infoPreamble;
        this.warnPreamble = warnPreamble;
        this.errorPreamble = errorPreamble;
        this.consoleLogLevel = consoleLogLevel;
        this.webhookLogLevel = webhookLogLevel;
    }

    debug(...data: any[]) {
        const timestamp = new Date().toISOString();
        const message = `${timestamp} [DEBUG] ${data.join(" ")}`;
        if (this.consoleLogLevel <= LogLevel.DEBUG) console.debug(message);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.DEBUG) {
            if (this.currentMessage.length + message.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.DEBUG) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.DEBUG;
                this.currentMessage = "```";
            }
            this.currentMessage += "\n" + message;
            this.resetQueueTimer();
        }
    }

    log(...data: any[]) {
        const timestamp = new Date().toISOString();
        const message = `${timestamp} [INFO] ${data.join(" ")}`;
        if (this.consoleLogLevel <= LogLevel.INFO) console.log(message);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.INFO) {
            if (this.currentMessage.length + message.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.INFO) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.INFO;
                this.currentMessage = this.infoPreamble + "\n```";
            }

            this.currentMessage += "\n" + message;
            this.resetQueueTimer();
        }
    }

    warn(...data: any[]) {
        const timestamp = new Date().toISOString();
        const message = `${timestamp} [WARN] ${data.join(" ")}`;
        if (this.consoleLogLevel <= LogLevel.WARN) console.warn(message);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.WARN) {
            if (this.currentMessage.length + message.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.WARN) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.WARN;
                this.currentMessage = this.warnPreamble + "\n```";
            }

            this.currentMessage += "\n" + message;
            this.resetQueueTimer();
        }
    }

    error(...data: any[]) {
        const timestamp = new Date().toISOString();
        const message = `${timestamp} [ERROR] ${data.join(" ")}`;
        if (this.consoleLogLevel <= LogLevel.ERROR) console.error(message);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.ERROR) {
            if (this.currentMessage.length + message.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.ERROR) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.ERROR;
                this.currentMessage = this.errorPreamble + "\n```";
            }

            this.currentMessage += "\n" + message;
            this.resetQueueTimer();
        }
    }

    private resetQueueTimer() {
        if (this.queueTimer) clearTimeout(this.queueTimer);
        this.queueTimer = setTimeout(() => this.flush(), this.inactivityMs);
    }

    async flush() {
        if (!this.webhookUrl) {
            this.currentMessage = '';
            return;
        }
        this.currentMessage += "\n```";
        this.webhookQueue.push(this.currentMessage);
        this.currentMessage = '';
        if (!this.webhookTimer) {
            this.webhookTimer = setInterval(() => this.processWebhookQueue(), 1000);
        }
    }

    private async processWebhookQueue() {
        if (this.webhookQueue.length === 0) {
            if (this.webhookTimer) {
                clearInterval(this.webhookTimer);
                this.webhookTimer = null;
            }
            return;
        }
        const message = this.webhookQueue.shift()!;
        if (!this.webhookUrl) {
            return;
        }
        await fetch(this.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content: message }),
        }).catch((err) => {
            console.error("Failed to send Discord webhook:", err);
        });
    }
}
