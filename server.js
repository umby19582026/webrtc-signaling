/**
 * SERVER DI SIGNALING WEBRTC + PROXY API
 * Deploy su Railway
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

// API Keys
const ASSEMBLYAI_KEY = 'e7d1c2fbbf6549a7a9e05d1e86af982d';
const DEEPL_KEY = '4ab89419-3478-43b7-97ed-edbfe49adcc4:fx';

// Helper per parsing body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// CORS headers - COMPLETO
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Crea server HTTP
const server = http.createServer(async (req, res) => {
  // CORS headers per TUTTE le risposte
  setCors(res);
  
  // Handle preflight OPTIONS - DEVE rispondere subito con 204
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Health check
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  
  // Proxy per AssemblyAI token
  if (req.url === '/api/assemblyai-token' && req.method === 'POST') {
    console.log('[PROXY] AssemblyAI token request');
    
    const postData = JSON.stringify({ expires_in: 3600 });
    
    const options = {
      hostname: 'api.assemblyai.com',
      path: '/v2/realtime/token',
      method: 'POST',
      headers: {
        'Authorization': ASSEMBLYAI_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        console.log('[PROXY] AssemblyAI response:', proxyRes.statusCode);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    
    proxyReq.on('error', (e) => {
      console.error('[PROXY] AssemblyAI error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    
    proxyReq.write(postData);
    proxyReq.end();
    return;
  }
  
  // Proxy per DeepL translate
  if (req.url === '/api/translate' && req.method === 'POST') {
    console.log('[PROXY] DeepL translate request');
    
    const body = await parseBody(req);
    const params = new URLSearchParams({
      auth_key: DEEPL_KEY,
      text: body.text || '',
      target_lang: body.target_lang || 'EN'
    });
    
    const postData = params.toString();
    
    const options = {
      hostname: 'api-free.deepl.com',
      path: '/v2/translate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const proxyReq = https.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        console.log('[PROXY] DeepL response:', proxyRes.statusCode);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    
    proxyReq.on('error', (e) => {
      console.error('[PROXY] DeepL error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    
    proxyReq.write(postData);
    proxyReq.end();
    return;
  }
  
  // Default response
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebRTC Signaling Server + Translation Proxy');
});

// WebSocket server
const wss = new WebSocket.Server({ server });

// Stanze per le chiamate
const rooms = new Map();
const clientRooms = new Map();

wss.on('connection', (ws) => {
  console.log('[WS] New connection');
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, message);
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (err) => {
    console.error('[WS] Error:', err);
    handleDisconnect(ws);
  });
});

function handleMessage(ws, message) {
  const { type, roomId, payload } = message;

  switch (type) {
    case 'join':
      joinRoom(ws, roomId, payload?.role);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
    case 'subtitle':
    case 'language-update':
      relayMessage(ws, roomId, message);
      break;
    case 'hang-up':
      broadcastToRoom(roomId, { type: 'hang-up' }, ws);
      break;
    default:
      console.log('[WS] Unknown type:', type);
  }
}

function joinRoom(ws, roomId, role = 'unknown') {
  if (!roomId) {
    ws.send(JSON.stringify({ type: 'error', message: 'roomId required' }));
    return;
  }

  handleDisconnect(ws);

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const room = rooms.get(roomId);
  
  if (room.size >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
    return;
  }

  room.add(ws);
  clientRooms.set(ws, roomId);
  ws.role = role;

  console.log(`[WS] ${role} joined ${roomId}. Size: ${room.size}`);

  ws.send(JSON.stringify({ type: 'joined', roomId, participants: room.size }));

  room.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'peer-joined', role }));
    }
  });
}

function relayMessage(ws, roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function handleDisconnect(ws) {
  const roomId = clientRooms.get(ws);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.delete(ws);
    
    room.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'peer-left' }));
      }
    });

    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`[WS] Room ${roomId} deleted`);
    }
  }

  clientRooms.delete(ws);
}

// Heartbeat
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleDisconnect(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
