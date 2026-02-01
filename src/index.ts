import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { DTS } from './dts';
import {
    port,
    updateInterval,
    wikiApiBaseUrl,
    apiBaseUrl,
    wikiPageRoot,
    discordWebhookUrl,
    discordWebhookInfoPrefix,
    discordWebhookWarnPrefix,
    discordWebhookErrorPrefix,    
    apiMinVersion,
    consoleLogLevel,
    webhookLogLevel,
} from './env';
import { DiscordLogger, LogLevel } from './logger';

const app = Fastify();

app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/',
});

const logger = new DiscordLogger(
    discordWebhookUrl,
    discordWebhookInfoPrefix,
    discordWebhookWarnPrefix,
    discordWebhookErrorPrefix,
    2000,
    LogLevel[consoleLogLevel.toUpperCase() as keyof typeof LogLevel],
    LogLevel[webhookLogLevel.toUpperCase() as keyof typeof LogLevel]
);
const dts = new DTS(logger, wikiApiBaseUrl, wikiPageRoot, apiBaseUrl);

async function updateFerretData() {
    try {
        await dts.updateFerretsData(apiMinVersion);
    } catch (err) {
        logger.error("Error updating ferret data. Update aborted.");
        logger.error(err);
    }
}

// Run webserver
async function run() {
    setInterval(() => {
        updateFerretData();
    }, updateInterval);
    
    logger.log("Performing initial ferret data update");
    await updateFerretData();

    logger.log("Performing initial OutNow data update");
    await dts.updateOutNowFerretsData(apiMinVersion);

    logger.log(`Starting server on port ${port}`);
    app.listen({ port }, (err, address) => {
        if (err) {
            logger.error(err);
            process.exit(1);
        }
        logger.log(`Server listening at ${address}`);
    });
}

run();
