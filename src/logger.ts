import { styleText } from "node:util";
import util from 'util';

export abstract class Logger {
    abstract debug(...data: any[]): void;
    abstract info(...data: any[]): void;
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
    private processingQueue: boolean = false; // Prevent concurrent queue processing

    private readonly maxChars: number;
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
        maxChars = 1900,
        consoleLogLevel = LogLevel.DEBUG,
        webhookLogLevel = LogLevel.INFO
    ) {
        super();
        this.webhookUrl = webhookUrl;
        this.maxChars = maxChars;
        this.infoPreamble = infoPreamble;
        this.warnPreamble = warnPreamble;
        this.errorPreamble = errorPreamble;
        this.consoleLogLevel = consoleLogLevel;
        this.webhookLogLevel = webhookLogLevel;
    }

    debug(...data: any[]) {
        const timestamp = new Date().toISOString();
        const details = this.formatData(...data);
        const whMessage = `[DEBUG] ${details}`;
        const cMessage = `${timestamp} [${styleText("gray", "DEBUG")}] ${details}`;
        if (this.consoleLogLevel <= LogLevel.DEBUG) console.debug(cMessage);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.DEBUG) {
            if (this.currentMessage.length + whMessage.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.DEBUG) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.DEBUG;
                this.currentMessage = "```";
            }
            this.currentMessage += "\n" + whMessage;
            this.resetQueueTimer();
        }
    }

    info(...data: any[]) {
        const timestamp = new Date().toISOString();
        const details = this.formatData(...data);
        const whMessage = `[INFO] ${details}`;
        const cMessage = `${timestamp} [${styleText(["bold", "white"], "INFO")}] ${details}`;
        if (this.consoleLogLevel <= LogLevel.INFO) console.log(cMessage);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.INFO) {
            if (this.currentMessage.length + whMessage.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.INFO) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.INFO;
                this.currentMessage = this.infoPreamble + "\n```";
            }

            this.currentMessage += "\n" + whMessage;
            this.resetQueueTimer();
        }
    }

    warn(...data: any[]) {
        const timestamp = new Date().toISOString();
        const details = this.formatData(...data);
        const whMessage = `[WARN] ${details}`;
        const cMessage = `${timestamp} [${styleText(["bold", "yellow"], "WARN")}] ${details}`;
        if (this.consoleLogLevel <= LogLevel.WARN) console.warn(cMessage);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.WARN) {
            if (this.currentMessage.length + whMessage.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.WARN) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.WARN;
                this.currentMessage = this.warnPreamble + "\n```";
            }

            this.currentMessage += "\n" + whMessage;
            this.resetQueueTimer();
        }
    }

    error(...data: any[]) {
        const timestamp = new Date().toISOString();
        const details = this.formatData(...data);
        const whMessage = `[ERROR] ${details}`;
        const cMessage = `${timestamp} [${styleText(["bold", "red"], "ERROR")}] ${details}`;
        if (this.consoleLogLevel <= LogLevel.ERROR) console.error(cMessage);

        if (this.webhookUrl && this.webhookLogLevel <= LogLevel.ERROR) {
            if (this.currentMessage.length + whMessage.length + 5 >= this.maxChars || this.currentMessageLevel !== LogLevel.ERROR) {
                this.flush();
            }

            if (this.currentMessage.length === 0) {
                this.currentMessageLevel = LogLevel.ERROR;
                this.currentMessage = this.errorPreamble + "\n```";
            }

            this.currentMessage += "\n" + whMessage;
            this.resetQueueTimer();
        }
    }

    private formatData(...data: any[]): string {
        return data.map(d => util.format(d)).join(' ');
    }

    private resetQueueTimer() {
        if (this.queueTimer) clearTimeout(this.queueTimer);
        this.queueTimer = setTimeout(() => {
            // Serialize flush to avoid race conditions
            this.flush();
        }, 10000);
    }

    private flush() {
        // Synchronously update state to avoid interleaving
        if (this.currentMessage.length === 0) return;
        if (!this.webhookUrl) {
            this.currentMessage = '';
            return;
        }
        this.currentMessage += "\n```";
        this.webhookQueue.push(this.currentMessage);
        this.currentMessage = '';
        this.startWebhookTimer();
    }

    private startWebhookTimer() {
        if (!this.webhookTimer) {
            this.webhookTimer = setInterval(() => this.processWebhookQueue(), 1000);
        }
    }

    private async processWebhookQueue() {
        if (this.processingQueue) return;
        this.processingQueue = true;
        try {
            if (this.webhookQueue.length === 0 || !this.webhookUrl) {
                if (this.webhookTimer) {
                    clearInterval(this.webhookTimer);
                    this.webhookTimer = null;
                }
                this.processingQueue = false;
                return;
            }
            const message = this.webhookQueue.shift()!;
            // Synchronously update queue before async call
            try {
                await fetch(this.webhookUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ content: message }),
                });
            } catch (err) {
                console.error("Failed to send Discord webhook:", err);
            }
        } finally {
            this.processingQueue = false;
        }
    }
}
