const express = require('express');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');

const app = express();

// Allow all origins (game can be on any domain)
app.use(cors());

// Health check endpoint (Render uses this to know the service is alive)
app.get('/', (req, res) => {
  res.json({
    name: 'PolyGun Signaling Server',
    status: 'online',
    connections: peerServer._clients ? Object.keys(peerServer._clients).size : 0
  });
});

const PORT = process.env.PORT || 9000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 PolyGun PeerJS Server running on port ${PORT}`);
});

const peerServer = ExpressPeerServer(server, {
  path: '/polygun',
  allow_discovery: true,  // Allow basic discovery if needed
  alive_timeout: 60000,   // 60 second heartbeat — keeps peers registered longer
  key: 'polygun',
  proxied: true            // IMPORTANT: Required when behind reverse proxy (Render, Railway, etc.)
});

app.use('/', peerServer);

peerServer.on('connection', (client) => {
  console.log(`[${new Date().toISOString()}] ✅ Peer connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[${new Date().toISOString()}] 👋 Peer disconnected: ${client.getId()}`);
});

peerServer.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] ❌ PeerServer Error:`, err);
});
