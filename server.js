/**
 * ============================================
 * SERVER DI SIGNALING WEBRTC
 * ============================================
 * Deploy su Render.com (gratuito)
 * Gestisce lo scambio di messaggi WebRTC tra PWA e PC
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Crea server HTTP per health check di Render
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebRTC Signaling Server attivo');
  }
});

// WebSocket server
const wss = new WebSocket.Server({ server });

// Stanze per le chiamate (roomId -> Set di WebSocket)
const rooms = new Map();

// Mapping client -> room
const clientRooms = new Map();

wss.on('connection', (ws) => {
  console.log('Nuova connessione WebSocket');
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, message);
    } catch (err) {
      console.error('Errore parsing messaggio:', err);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('Errore WebSocket:', err);
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
      relayMessage(ws, roomId, message);
      break;

    case 'hang-up':
      broadcastToRoom(roomId, { type: 'hang-up' }, ws);
      break;

    default:
      console.log('Tipo messaggio sconosciuto:', type);
  }
}

function joinRoom(ws, roomId, role = 'unknown') {
  if (!roomId) {
    ws.send(JSON.stringify({ type: 'error', message: 'roomId richiesto' }));
    return;
  }

  // Rimuovi da stanza precedente se presente
  handleDisconnect(ws);

  // Crea stanza se non esiste
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const room = rooms.get(roomId);
  
  // Max 2 partecipanti per stanza
  if (room.size >= 2) {
    ws.send(JSON.stringify({ type: 'error', message: 'Stanza piena' }));
    return;
  }

  // Aggiungi alla stanza
  room.add(ws);
  clientRooms.set(ws, roomId);
  ws.role = role;

  console.log(`Client ${role} unito alla stanza ${roomId}. Partecipanti: ${room.size}`);

  // Notifica il client
  ws.send(JSON.stringify({ 
    type: 'joined', 
    roomId,
    participants: room.size
  }));

  // Notifica altri partecipanti
  room.forEach((client) => {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ 
        type: 'peer-joined',
        role: role
      }));
    }
  });
}

function relayMessage(ws, roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Inoltra a tutti tranne il mittente
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
    
    // Notifica altri partecipanti
    room.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'peer-left' }));
      }
    });

    // Elimina stanza vuota
    if (room.size === 0) {
      rooms.delete(roomId);
      console.log(`Stanza ${roomId} eliminata`);
    }
  }

  clientRooms.delete(ws);
}

// Heartbeat per mantenere connessioni attive
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

wss.on('close', () => {
  clearInterval(heartbeat);
});

server.listen(PORT, () => {
  console.log(`🚀 Signaling server attivo su porta ${PORT}`);
});
