
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { DTS } from './dts';
import { port, updateInterval, wikiApiBaseUrl, apiBaseUrl, wikiPageRoot, discordWebhookUrl, discordWebhookInfoPrefix, discordWebhookErrorPrefix, apiMinVersion } from './env';

const app = Fastify();

app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/',
});

// Webhooks
async function sendDiscordWebhook(message: string, isError: boolean = false) {
    if (!discordWebhookUrl) {
        console.log("Discord webhook URL not set, skipping webhook");
        return;
    }
    const prefix = isError ? discordWebhookErrorPrefix : discordWebhookInfoPrefix;
    const fullMessage = prefix + "\n" + message;
    console.log("Sending Discord webhook:", fullMessage, "to", discordWebhookUrl);
    await fetch(discordWebhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: fullMessage }),
    }).catch((err) => {
        console.error("Failed to send Discord webhook:", err);
    });
}

// DTS instance
const dts = new DTS(wikiApiBaseUrl, wikiPageRoot, apiBaseUrl);

async function updateFerretData() {
    await dts.updateFerretsData(apiMinVersion);
    try {
        // sendDiscordWebhook("Data update completed successfully.");
    } catch (err) {
        console.error("Error updating data:", err);
        // sendDiscordWebhook(`\`\`\`\n${err}\n\`\`\``, true);
    }
}

// Run webserver
async function run() {
    setInterval(() => {
        updateFerretData();
    }, updateInterval);
    
    console.log("Performing initial ferret data update");
    await updateFerretData();

    console.log("Performing initial OutNow data update");
    await dts.updateOutNowFerretsData(apiMinVersion);

    console.log(`Starting server on port ${port}`);
    app.listen({ port }, (err, address) => {
        if (err) {
            app.log.error(err);
            process.exit(1);
        }
        console.log(`Server listening at ${address}`);
    });
}

run();
