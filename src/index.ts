import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createApp } from './app.js';
import { config } from './config.js';
import { createDb } from './db/client.js';

const db = await createDb(config.databaseUrl, config.databaseAuthToken);
const app = createApp(db);

/** A TLS connection opens with a handshake record, whose first byte is 0x16. Plain HTTP opens with a method name. */
const TLS_HANDSHAKE = 0x16;

/** Plain HTTP, or with a certificate configured, HTTP and HTTPS on the one port, told apart by their first byte. */
function listen() {
  const plain = http.createServer(app);
  if (!config.tlsCertFile || !config.tlsKeyFile) return plain;
  const secure = https.createServer({ cert: readFileSync(config.tlsCertFile), key: readFileSync(config.tlsKeyFile) }, app);
  // A device that rejects the certificate closes the connection here, so say so.
  secure.on('tlsClientError', (err, socket) => console.warn(`TLS handshake with ${socket.remoteAddress} failed: ${err.message}`));
  return net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.once('data', (first) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === TLS_HANDSHAKE ? secure : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
}

listen().listen(config.port, () => {
  const tls = config.tlsCertFile && config.tlsKeyFile;
  console.log(`Coplaces API listening on http://localhost:${config.port}${tls ? ` (and https:// on the same port)` : ''}`);
  if (!config.isProd && config.jwtSecret === 'dev-only-secret-change-me') {
    console.log('Using the development JWT secret. Set JWT_SECRET before deploying.');
  }
});
