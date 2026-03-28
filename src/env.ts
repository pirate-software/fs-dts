import dotenv from 'dotenv';

dotenv.config();

if (!process.env.PORT) {
    throw new Error('PORT not set in environment variables. Did you make a .env file?');
}

if (!process.env.UPDATE_INTERVAL_SECONDS) {
    throw new Error('UPDATE_INTERVAL_SECONDS not set in environment variables.');
}

if (!process.env.WIKI_API_URL) {
    throw new Error('WIKI_API_URL not set in environment variables.');
}

if (!process.env.API_BASE_URL) {
    throw new Error('API_BASE_URL not set in environment variables.');
}

if (!process.env.WIKI_PAGE_ROOT) {
    throw new Error('WIKI_PAGE_ROOT not set in environment variables.');
}

if (!process.env.API_MIN_VERSION) {
    throw new Error('API_MIN_VERSION not set in environment variables.');
}

let _discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;
let _discordWebhookInfoPrefix = process.env.DISCORD_WEBHOOK_INFO_PREAMBLE || "";
let _discordWebhookWarnPrefix = process.env.DISCORD_WEBHOOK_WARN_PREAMBLE || "";
let _discordWebhookErrorPrefix = process.env.DISCORD_WEBHOOK_ERROR_PREAMBLE || "";

let _consoleLogLevel = process.env.CONSOLE_LOG_LEVEL || "debug";
let _webhookLogLevel = process.env.WEBHOOK_LOG_LEVEL || "info";

let validLogLevels = ["debug", "info", "warn", "error"];
if (!validLogLevels.includes(_consoleLogLevel.toLowerCase())) {
    throw new Error(`Invalid CONSOLE_LOG_LEVEL "${_consoleLogLevel}"`);
}
if (!validLogLevels.includes(_webhookLogLevel.toLowerCase())) {
    throw new Error(`Invalid WEBHOOK_LOG_LEVEL "${_webhookLogLevel}"`);
}

// Cloudflare Access tokens
const _cfAccessClientId = process.env.CF_ACCESS_CLIENT_ID || null;
const _cfAccessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET || null;

// Optionally, validate if both are set or both are null
if ((_cfAccessClientId && !_cfAccessClientSecret) || (!_cfAccessClientId && _cfAccessClientSecret)) {
    throw new Error('Both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together for Cloudflare Access.');
}

if (!_discordWebhookUrl || !_discordWebhookUrl.startsWith('http')) {
    console.log("Discord webhook not set")
    _discordWebhookUrl = null;
}

export const port: number = parseInt(process.env.PORT);
export const updateInterval: number = parseInt(process.env.UPDATE_INTERVAL_SECONDS) * 1000;
export const wikiApiBaseUrl: string = process.env.WIKI_API_URL;
export const apiBaseUrl: string = process.env.API_BASE_URL;
export const wikiPageRoot: string = process.env.WIKI_PAGE_ROOT;
export const discordWebhookUrl: string | null = _discordWebhookUrl;
export const discordWebhookInfoPrefix: string = _discordWebhookInfoPrefix;
export const discordWebhookWarnPrefix: string = _discordWebhookWarnPrefix;
export const discordWebhookErrorPrefix: string = _discordWebhookErrorPrefix;
export const apiMinVersion: string = process.env.API_MIN_VERSION;
export const consoleLogLevel: string = _consoleLogLevel.toLowerCase();
export const webhookLogLevel: string = _webhookLogLevel.toLowerCase();

export const cfAccessClientId: string | null = _cfAccessClientId;
export const cfAccessClientSecret: string | null = _cfAccessClientSecret;
