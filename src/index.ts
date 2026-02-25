import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { DTS } from './dts/dts';
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
import { WikiFetcher } from './dts/wiki';
import { FileHandler } from './dts/files';

const app = Fastify();

app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    done();
});

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
const dts = new DTS(
    logger,
    new WikiFetcher(logger, wikiApiBaseUrl, wikiPageRoot),
    new FileHandler(logger),
    apiBaseUrl
);

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
    
    logger.info("Performing initial ferret data update");
    await updateFerretData();

    logger.info("Performing initial OutNow data update");
    await dts.updateOutNowFerretsData(apiMinVersion);

    logger.info(`Starting server on port ${port}`);
    app.listen({ port, host: '0.0.0.0' }, (err, address) => {
        if (err) {
            logger.error(err);
            process.exit(1);
        }
        logger.info(`Server listening at ${address}`);
    });
}

run();
