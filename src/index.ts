import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.PORT) {
    console.log('PORT not set in environment variables. Did you make a .env file?');
    process.exit(1);
}

const port = parseInt(process.env.PORT);
const app = Fastify();

app.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
    prefix: '/',
});

app.listen({ port }, (err, address) => {
    if (err) {
        app.log.error(err);
        process.exit(1);
    }
    console.log(`Server listening at ${address}`);
});

