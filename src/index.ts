
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import dotenv from 'dotenv';
import { updateData } from './dts';

dotenv.config();


if (!process.env.PORT) {
    console.log('PORT not set in environment variables. Did you make a .env file?');
    process.exit(1);
}

if (!process.env.UPDATE_INTERVAL_SECONDS) {
    console.log('UPDATE_INTERVAL_SECONDS not set in environment variables.');
    process.exit(1);
}

if (!process.env.WIKI_API_URL) {
    console.log('WIKI_API_URL not set in environment variables.');
    process.exit(1);
}

if (!process.env.API_BASE_URL) {
    console.log('API_BASE_URL not set in environment variables.');
    process.exit(1);
}


const port = parseInt(process.env.PORT);
const updateInterval = parseInt(process.env.UPDATE_INTERVAL_SECONDS) * 1000;
const wikiBaseUrl = process.env.WIKI_API_URL;
const apiBaseUrl = process.env.API_BASE_URL;

const app = Fastify();

app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/',
});

// Call updateData every UPDATE_INTERVAL_SECONDS
setInterval(() => {
    updateData(wikiBaseUrl, apiBaseUrl);
}, updateInterval);

console.log("Performing initial data update...");
updateData(wikiBaseUrl, apiBaseUrl);

console.log(`Starting server on port ${port}...`);
app.listen({ port }, (err, address) => {
    if (err) {
        app.log.error(err);
        process.exit(1);
    }
    console.log(`Server listening at ${address}`);
});
