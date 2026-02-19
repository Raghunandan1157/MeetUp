const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Try HTTPS first (needed for camera/mic on non-localhost devices)
let server;
let isHttps = false;
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  server = https.createServer({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  }, app);
  isHttps = true;
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server });

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// rooms: Map<roomId, Map<peerId, WebSocket>>
const rooms = new Map();

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function removeFromRoom(peerId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(peerId);
  console.log(`[Room ${roomId}] Peer ${peerId} removed. ${room.size} peer(s) remaining.`);

  // Notify remaining peers about the departure
  for (const [otherPeerId, otherWs] of room) {
    safeSend(otherWs, {
      type: 'peer-left',
      peerId,
    });
  }

  // Clean up empty rooms
  if (room.size === 0) {
    rooms.delete(roomId);
    console.log(`[Room ${roomId}] Empty, removed.`);
  }
}

function safeSend(ws, data) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('Error sending message:', err.message);
    }
  }
}

wss.on('connection', (ws) => {
  const peerId = generateId();
  let currentRoomId = null;

  console.log(`[Connection] Peer ${peerId} connected.`);

  // Send the peer their assigned ID
  safeSend(ws, { type: 'welcome', peerId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn(`[Peer ${peerId}] Invalid JSON received.`);
      safeSend(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const { type } = msg;

    switch (type) {
      case 'join': {
        const { roomId } = msg;
        if (!roomId || typeof roomId !== 'string') {
          safeSend(ws, { type: 'error', message: 'roomId is required' });
          return;
        }

        // Leave current room if already in one
        if (currentRoomId) {
          removeFromRoom(peerId, currentRoomId);
        }

        currentRoomId = roomId;
        const room = getRoom(roomId);

        // Collect existing participants before adding the new one
        const existingPeers = Array.from(room.keys());

        // Add to room
        room.set(peerId, ws);
        console.log(`[Room ${roomId}] Peer ${peerId} joined. ${room.size} peer(s) in room.`);

        // Tell the new peer about existing participants
        safeSend(ws, {
          type: 'room-joined',
          roomId,
          peerId,
          peers: existingPeers,
        });

        // Notify existing peers about the new participant
        for (const [otherPeerId, otherWs] of room) {
          if (otherPeerId !== peerId) {
            safeSend(otherWs, {
              type: 'peer-joined',
              peerId,
            });
          }
        }
        break;
      }

      case 'offer': {
        const { targetPeerId, offer } = msg;
        if (!currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Not in a room' });
          return;
        }
        const room = rooms.get(currentRoomId);
        if (!room) return;

        const targetWs = room.get(targetPeerId);
        if (targetWs) {
          safeSend(targetWs, {
            type: 'offer',
            offer,
            peerId, // who the offer is from
          });
        }
        break;
      }

      case 'answer': {
        const { targetPeerId, answer } = msg;
        if (!currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Not in a room' });
          return;
        }
        const room = rooms.get(currentRoomId);
        if (!room) return;

        const targetWs = room.get(targetPeerId);
        if (targetWs) {
          safeSend(targetWs, {
            type: 'answer',
            answer,
            peerId,
          });
        }
        break;
      }

      case 'ice-candidate': {
        const { targetPeerId, candidate } = msg;
        if (!currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Not in a room' });
          return;
        }
        const room = rooms.get(currentRoomId);
        if (!room) return;

        const targetWs = room.get(targetPeerId);
        if (targetWs) {
          safeSend(targetWs, {
            type: 'ice-candidate',
            candidate,
            peerId,
          });
        }
        break;
      }

      case 'leave': {
        if (currentRoomId) {
          removeFromRoom(peerId, currentRoomId);
          safeSend(ws, { type: 'left', roomId: currentRoomId });
          currentRoomId = null;
        }
        break;
      }

      case 'chat': {
        const { message } = msg;
        if (!currentRoomId) {
          safeSend(ws, { type: 'error', message: 'Not in a room' });
          return;
        }
        if (!message || typeof message !== 'string') {
          safeSend(ws, { type: 'error', message: 'Chat message is required' });
          return;
        }

        const room = rooms.get(currentRoomId);
        if (!room) return;

        const chatPayload = {
          type: 'chat',
          peerId,
          message,
          timestamp: Date.now(),
        };

        // Broadcast chat to all peers in the room (including sender)
        for (const [, otherWs] of room) {
          safeSend(otherWs, chatPayload);
        }
        break;
      }

      default:
        safeSend(ws, { type: 'error', message: `Unknown message type: ${type}` });
    }
  });

  ws.on('close', () => {
    console.log(`[Connection] Peer ${peerId} disconnected.`);
    if (currentRoomId) {
      removeFromRoom(peerId, currentRoomId);
      currentRoomId = null;
    }
  });

  ws.on('error', (err) => {
    console.error(`[Peer ${peerId}] WebSocket error:`, err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const protocol = isHttps ? 'https' : 'http';
  console.log(`Signaling server running on ${protocol}://localhost:${PORT}`);
  if (isHttps) {
    console.log(`Mobile/LAN access: https://192.168.1.229:${PORT}`);
    console.log('(Accept the self-signed certificate warning in the browser)');
  }
});
