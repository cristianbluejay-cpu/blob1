// Blob Arena — simple WebSocket relay server
//
// This is intentionally dumb: it does no game logic, no anti-cheat, no
// physics. It just puts clients into named "rooms" and forwards whatever
// state/chat messages they send to everyone else in the same room. Each
// client's game loop is still authoritative over its own player, so this
// is a relay, not a real game server — good enough for a small game with
// trusted players (you and your friends).
//
// Run locally:   npm install && node server.js
// Deploy: push this folder to Railway / Fly.io / Render (Node.js service),
// set the start command to `node server.js`. The platform sets PORT for you.

const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

let nextId = 1;
const rooms = new Map();       // roomName -> Set<ws>
const clientsById = new Map(); // id -> ws, used to resolve "join by friend's ID"

function broadcastToRoom(room, data, exceptWs) {
    const members = rooms.get(room);
    if (!members) return;
    const msg = JSON.stringify(data);
    for (const client of members) {
        if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

function joinRoom(ws, room) {
    if (ws.room && rooms.has(ws.room)) {
        rooms.get(ws.room).delete(ws);
        broadcastToRoom(ws.room, { type: 'leave', id: ws.id }, ws);
    }
    ws.room = room;
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(ws);
    broadcastToRoom(room, { type: 'join', id: ws.id, name: ws.name }, ws);
}

wss.on('connection', ws => {
    ws.id = 'p' + (nextId++);
    ws.room = null;
    ws.name = 'Player';
    clientsById.set(ws.id, ws);

    ws.send(JSON.stringify({ type: 'id', id: ws.id }));

    ws.on('message', raw => {
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return; // ignore malformed messages instead of crashing the server
        }

        if (data.name) ws.name = String(data.name).slice(0, 20);

        if (data.type === 'join') {
            joinRoom(ws, String(data.room || 'default').slice(0, 64));
            return;
        }

        if (data.type === 'joinById') {
            const target = clientsById.get(String(data.targetId || ''));
            if (target && target.room) {
                joinRoom(ws, target.room);
                ws.send(JSON.stringify({ type: 'joinResult', ok: true, room: target.room }));
            } else {
                ws.send(JSON.stringify({ type: 'joinResult', ok: false }));
            }
            return;
        }

        if (!ws.room) return; // must be in a room before sending anything else

        if (data.type === 'state') {
            broadcastToRoom(ws.room, {
                type: 'state',
                id: ws.id,
                name: ws.name,
                x: data.x, y: data.y,
                msg: data.msg, msgTime: data.msgTime,
                shieldTime: data.shieldTime, explodeTime: data.explodeTime, parryFlash: data.parryFlash,
                parries: data.parries || 0, flinchTime: data.flinchTime || 0, slowTime: data.slowTime || 0,
                goals: data.goals || 0, catches: data.catches || 0,
                color: data.color, hat: data.hat
            }, ws);
        } else if (data.type === 'chat') {
            broadcastToRoom(ws.room, { type: 'chat', id: ws.id, msg: String(data.msg || '').slice(0, 200) }, ws);
        } else if (data.type === 'parryHit' || data.type === 'slowHit' || data.type === 'goalScored' || data.type === 'foundHider') {
            const target = clientsById.get(String(data.targetId || ''));
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: data.type, targetId: target.id }));
            }
        }
    });

    ws.on('close', () => {
        clientsById.delete(ws.id);
        if (ws.room && rooms.has(ws.room)) {
            const members = rooms.get(ws.room);
            members.delete(ws);
            broadcastToRoom(ws.room, { type: 'leave', id: ws.id }, ws);
            if (members.size === 0) rooms.delete(ws.room);
        }
    });
});

console.log('Blob Arena relay server listening on port ' + PORT);
