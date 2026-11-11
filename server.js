/**
 * ShaderCraft Studio — Servidor Multijugador Node.js + Express + Socket.IO
 * Ecosistema Fullscreen Code (FSC)
 */
require('dotenv').config({ override: true });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3255;
const BASE_PATH = process.env.BASE_PATH || '/shadercraft';
const STATE_FILE = path.join(__dirname, '.world-state.json');

const ORIGENES_FSC = [
    'https://fullscreencode.com', 'https://www.fullscreencode.com',
    'https://artedigitaldata.com', 'https://www.artedigitaldata.com',
    'https://exporural.com', 'https://www.exporural.com',
    'https://exporuralsanjuan.com', 'https://www.exporuralsanjuan.com',
    'https://vuelapelucas3000.com', 'https://www.vuelapelucas3000.com',
    'https://vuelapelucas3000.com.ar', 'https://www.vuelapelucas3000.com.ar',
    'https://jpupper.com', 'https://www.jpupper.com',
    'https://volumetricsuite.com', 'https://www.volumetricsuite.com',
    'https://vps-4455523-x.dattaweb.com'
];

function esOrigenLocal(origin) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/i.test(String(origin || ''));
}

const app = express();
const server = http.createServer(app);

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ORIGENES_FSC.includes(origin) || esOrigenLocal(origin)) return cb(null, true);
        return cb(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true
}));

app.use(express.json({ limit: '15mb' }));

// Socket.IO configurado en /shadercraft/socket.io para Dual-Hosting (FTP + VPS Nginx) y Local
const io = new Server(server, {
    path: `${BASE_PATH}/socket.io`,
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// ============================================================================
// ESTADO AUTORITATIVO DEL MUNDO MULTIJUGADOR (MEMORIA + SNAPSHOT EN DISCO)
// ============================================================================
const DEFAULT_WORLD_STATE = {
    biomeParams: {
        preset: 'forest',
        size: 64,
        hillHeight: 8,
        treeDensity: 0.58,
        stoneAbundance: 0.45,
        waterLevel: 2,
        seed: 42857
    },
    materials: {
        blocks: {},
        skyConfig: {
            mode: 'preset',
            preset: 'day',
            color: '#7dd3fc',
            shaderKind: 'builtin',
            shaderValue: 'sunset_sky_aurora'
        }
    },
    voxelDeltas: {} // "x,y,z" -> blockId (string) | null (bloque picado/borrado)
};

let worldState = loadWorldState();
let saveTimer = null;

function loadWorldState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (raw && raw.biomeParams) {
                return {
                    biomeParams: { ...DEFAULT_WORLD_STATE.biomeParams, ...raw.biomeParams },
                    materials: {
                        blocks: (raw.materials && raw.materials.blocks) || {},
                        skyConfig: { ...DEFAULT_WORLD_STATE.materials.skyConfig, ...(raw.materials && raw.materials.skyConfig) }
                    },
                    voxelDeltas: raw.voxelDeltas || {}
                };
            }
        }
    } catch (e) {
        console.warn('[ShaderCraft] No se pudo leer .world-state.json, usando estado inicial:', e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_WORLD_STATE));
}

function scheduleSaveState() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            // Limitar deltas excesivos para evitar archivos gigantes
            const keys = Object.keys(worldState.voxelDeltas);
            if (keys.length > 60000) {
                const toRemove = keys.slice(0, keys.length - 50000);
                for (const k of toRemove) delete worldState.voxelDeltas[k];
            }
            fs.writeFileSync(STATE_FILE, JSON.stringify(worldState));
        } catch (e) {
            console.warn('[ShaderCraft] Error guardando snapshot:', e.message);
        }
    }, 1500);
    if (saveTimer.unref) saveTimer.unref();
}

// Jugadores conectados en tiempo real: socket.id -> PlayerState
const players = new Map();
const PLAYER_COLORS = [
    '#0ea5e9', '#ec4899', '#10b981', '#f59e0b',
    '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16'
];
let playerSeq = 1;

io.on('connection', (socket) => {
    const color = PLAYER_COLORS[(playerSeq - 1) % PLAYER_COLORS.length];
    const defaultName = `Jugador_${playerSeq++}`;

    const playerState = {
        id: socket.id,
        name: defaultName,
        color,
        x: 0,
        y: 8,
        z: 0,
        yaw: 0,
        pitch: 0,
        mode: 'user',
        heldType: 'tool',
        heldBlockId: 'grass',
        isSwinging: false,
        isWalking: false,
        joinedAt: Date.now()
    };

    players.set(socket.id, playerState);

    // 1. Enviar estado completo del mundo y lista de jugadores al recién conectado
    socket.emit('initWorld', {
        selfId: socket.id,
        selfPlayer: playerState,
        worldState,
        players: Array.from(players.values())
    });

    // 2. Avisar a los demás jugadores que entró alguien nuevo
    socket.broadcast.emit('playerJoined', playerState);

    // 3. Actualización de posición, rotación y animación en tiempo real
    socket.on('playerUpdate', (data) => {
        if (!data || typeof data !== 'object') return;
        const p = players.get(socket.id);
        if (!p) return;

        if (Number.isFinite(data.x)) p.x = Number(data.x);
        if (Number.isFinite(data.y)) p.y = Number(data.y);
        if (Number.isFinite(data.z)) p.z = Number(data.z);
        if (Number.isFinite(data.yaw)) p.yaw = Number(data.yaw);
        if (Number.isFinite(data.pitch)) p.pitch = Number(data.pitch);
        if (typeof data.mode === 'string') p.mode = data.mode === 'god' ? 'god' : 'user';
        if (typeof data.heldType === 'string') p.heldType = data.heldType;
        if (typeof data.heldBlockId === 'string') p.heldBlockId = data.heldBlockId;
        p.isSwinging = !!data.isSwinging;
        p.isWalking = !!data.isWalking;

        socket.broadcast.emit('playerMoved', p);
    });

    // 4. Cambio de nombre o color de camiseta del jugador
    socket.on('playerProfile', (data) => {
        if (!data || typeof data !== 'object') return;
        const p = players.get(socket.id);
        if (!p) return;
        if (typeof data.name === 'string') {
            const clean = data.name.trim().slice(0, 20);
            if (clean) p.name = clean;
        }
        if (typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) {
            p.color = data.color;
        }
        io.emit('playerUpdated', p);
    });

    // 5. Picar un cubo (Modo Juego o Modo Dios)
    socket.on('blockMine', (data) => {
        if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.z)) return;
        const x = data.x | 0;
        const y = data.y | 0;
        const z = data.z | 0;
        const k = `${x},${y},${z}`;
        worldState.voxelDeltas[k] = null;
        scheduleSaveState();

        socket.broadcast.emit('blockMined', {
            x,
            y,
            z,
            spawnDrop: data.spawnDrop !== false,
            by: socket.id
        });
    });

    // 6. Poner un cubo individual
    socket.on('blockPlace', (data) => {
        if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.z) || !data.blockId) return;
        const x = data.x | 0;
        const y = data.y | 0;
        const z = data.z | 0;
        const blockId = String(data.blockId);
        const k = `${x},${y},${z}`;

        if (data.blockDef && typeof data.blockDef === 'object' && data.blockDef.id) {
            worldState.materials.blocks[data.blockDef.id] = data.blockDef;
        }
        worldState.voxelDeltas[k] = blockId;
        scheduleSaveState();

        socket.broadcast.emit('blockPlaced', {
            x,
            y,
            z,
            blockId,
            blockDef: data.blockDef || null,
            by: socket.id
        });
    });

    // 7. Lote de cubos en Modo Dios (pinceles 2x2, 3x3, Torre, Borrar o Pintar)
    socket.on('blocksBatch', (data) => {
        if (!data || !Array.isArray(data.changes) || !data.changes.length) return;
        if (data.blockDef && typeof data.blockDef === 'object' && data.blockDef.id) {
            worldState.materials.blocks[data.blockDef.id] = data.blockDef;
        }
        const validChanges = [];
        for (const ch of data.changes.slice(0, 250)) {
            if (!ch || !Number.isFinite(ch.x) || !Number.isFinite(ch.y) || !Number.isFinite(ch.z)) continue;
            const x = ch.x | 0;
            const y = ch.y | 0;
            const z = ch.z | 0;
            const bId = ch.blockId ? String(ch.blockId) : null;
            worldState.voxelDeltas[`${x},${y},${z}`] = bId;
            validChanges.push({ x, y, z, blockId: bId });
        }
        if (!validChanges.length) return;
        scheduleSaveState();

        socket.broadcast.emit('blocksBatched', {
            changes: validChanges,
            blockDef: data.blockDef || null,
            by: socket.id
        });
    });

    // 8. Cambio de apariencia de un bloque del bioma (Pasto, Piedra, Madera, Hojas, Agua, Cielo)
    socket.on('materialUpdate', (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.blockId && data.changes && typeof data.changes === 'object') {
            const cur = worldState.materials.blocks[data.blockId] || { id: data.blockId };
            worldState.materials.blocks[data.blockId] = { ...cur, ...data.changes };
        }
        if (data.skyConfig && typeof data.skyConfig === 'object') {
            worldState.materials.skyConfig = { ...worldState.materials.skyConfig, ...data.skyConfig };
        }
        scheduleSaveState();

        socket.broadcast.emit('materialUpdated', {
            blockId: data.blockId || null,
            changes: data.changes || null,
            skyConfig: data.skyConfig || null,
            by: socket.id
        });
    });

    // 9. Generación de nuevo Bioma (sincroniza semilla, tamaño, parámetros y limpia deltas)
    socket.on('biomeGenerate', (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.biomeParams && typeof data.biomeParams === 'object') {
            worldState.biomeParams = { ...worldState.biomeParams, ...data.biomeParams };
        }
        if (data.materials && typeof data.materials === 'object') {
            if (data.materials.blocks) {
                worldState.materials.blocks = { ...worldState.materials.blocks, ...data.materials.blocks };
            }
            if (data.materials.skyConfig) {
                worldState.materials.skyConfig = { ...worldState.materials.skyConfig, ...data.materials.skyConfig };
            }
        }
        worldState.voxelDeltas = {};
        scheduleSaveState();

        const p = players.get(socket.id);
        socket.broadcast.emit('biomeGenerated', {
            biomeParams: worldState.biomeParams,
            materials: worldState.materials,
            by: socket.id,
            byName: p ? p.name : 'Jugador'
        });
    });

    // 10. Desconexión
    socket.on('disconnect', () => {
        players.delete(socket.id);
        io.emit('playerLeft', { id: socket.id });
    });
});

// ============================================================================
// ENDPOINTS REST Y ARCHIVOS ESTÁTICOS
// ============================================================================
function statusHandler(req, res) {
    res.json({
        ok: true,
        app: 'shadercraft',
        playersOnline: players.size,
        players: Array.from(players.values()).map(p => ({ id: p.id, name: p.name, color: p.color, mode: p.mode })),
        biomeParams: worldState.biomeParams,
        voxelDeltasCount: Object.keys(worldState.voxelDeltas).length
    });
}

app.get(`${BASE_PATH}/api/status`, statusHandler);
app.get('/api/status', statusHandler);

const publicDir = path.join(__dirname, 'public');
app.use(BASE_PATH, express.static(publicDir));
app.use('/', express.static(publicDir));

server.listen(PORT, () => {
    console.log('==========================================================');
    console.log(`⛏️  ShaderCraft Multijugador corriendo en puerto ${PORT}`);
    console.log(`👉 Local:     http://localhost:${PORT}${BASE_PATH}/`);
    console.log(`👉 Raíz:      http://localhost:${PORT}/`);
    console.log(`👉 Socket.IO: ${BASE_PATH}/socket.io`);
    console.log('==========================================================');
});
