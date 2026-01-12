const http = require('http');

const { createTmdbProxyHandler } = require('./src/tmdbProxy');

const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';

const handler = createTmdbProxyHandler();

const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
        console.error('Unhandled error:', error);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        res.end(
            JSON.stringify({
                error: 'Internal Server Error'
            })
        );
    });
});

server.listen(port, host, () => {
    console.log(`tmdb-proxy listening on http://${host}:${port}`);
});

