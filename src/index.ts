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
    apiMinVersion } from './env';
import { DiscordLogger } from './logger';

const app = Fastify();

app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/',
});

const logger = new DiscordLogger(discordWebhookUrl, discordWebhookInfoPrefix, discordWebhookWarnPrefix, discordWebhookErrorPrefix);
const dts = new DTS(logger, wikiApiBaseUrl, wikiPageRoot, apiBaseUrl);

async function updateFerretData() {
    await dts.updateFerretsData(apiMinVersion);
    try {
        logger.log("Data update completed successfully.");
    } catch (err) {
        logger.error("Error updating data: " + err);
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
