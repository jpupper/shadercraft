/**
 * MultiplayerManager — Sincronización Multijugador en Tiempo Real vía Socket.IO
 * -----------------------------------------------------------------------------
 * - Sincroniza el estado del bioma, materiales/shaders, bloques picados y colocados
 *   (tanto en Modo Juego como trazos por lotes en Modo Dios).
 * - Renderiza avatares Voxel 3D articulados para todos los demás jugadores conectados
 *   con interpolación suave, animación de caminar, pico/cubo en mano y etiqueta de nombre.
 */
class MultiplayerManager {
    constructor(scene, world, materialManager, player) {
        this.scene = scene;
        this.world = world;
        this.materialManager = materialManager;
        this.player = player;

        this.socket = null;
        this.connected = false;
        this.selfId = null;
        this.playerName = localStorage.getItem('shadercraft_nickname') || `Jugador_${Math.floor(100 + Math.random() * 899)}`;
        this.playerColor = '#38bdf8';

        // Mapa de jugadores remotos: id -> RemotePlayerObj
        this.remotePlayers = new Map();
        this.remotePlayersGroup = new THREE.Group();
        this.scene.add(this.remotePlayersGroup);

        // Temporizador de envío de posición (15 Hz)
        this.syncAccumulator = 0;
        this.syncInterval = 0.066;

        // Callbacks de UI
        this.onStatusChange = null;
        this.onToast = null;
        this.onRemoteBiomeSynced = null;
        this.onRemoteMaterialSynced = null;
    }

    connect() {
        if (typeof window.io !== 'function') {
            console.warn('[Multiplayer] Socket.IO client no disponible.');
            this.notifyStatus();
            return;
        }

        const cfg = window.CONFIG || {
            SOCKET_ORIGIN: window.location.origin,
            SOCKET_PATH: '/shadercraft/socket.io'
        };

        try {
            this.socket = window.io(cfg.SOCKET_ORIGIN, {
                path: cfg.SOCKET_PATH,
                transports: ['websocket', 'polling'],
                reconnectionAttempts: 15,
                reconnectionDelay: 1500
            });
        } catch (err) {
            console.warn('[Multiplayer] Error iniciando socket:', err);
            return;
        }

        this.socket.on('connect', () => {
            this.connected = true;
            this.selfId = this.socket.id;
            this.socket.emit('playerProfile', { name: this.playerName });
            this.notifyStatus();
        });

        this.socket.on('disconnect', () => {
            this.connected = false;
            this.notifyStatus();
        });

        // Estado inicial completo del mundo enviado por el servidor al entrar
        this.socket.on('initWorld', (payload) => {
            if (!payload) return;
            this.selfId = payload.selfId || this.socket.id;

            // 1. Registrar bloques personalizados y materiales del bioma
            if (payload.customBlocks && typeof payload.customBlocks === 'object') {
                for (const def of Object.values(payload.customBlocks)) {
                    this.materialManager.registerCustomBlockDef(def);
                }
            }
            if (payload.materials && typeof payload.materials === 'object') {
                for (const [bId, def] of Object.entries(payload.materials)) {
                    this.materialManager.updateBlockAppearance(bId, def);
                }
            }
            if (payload.skyConfig) {
                Object.assign(this.materialManager.skyConfig, payload.skyConfig);
            }

            // 2. Generar el bioma con los parámetros autoritativos del servidor y aplicar deltas
            if (payload.biomeParams) {
                this.world.generateBiome(payload.biomeParams, true);
            }
            if (payload.voxelDeltas) {
                this.world.applyVoxelDeltas(payload.voxelDeltas);
            }

            // Posicionar al jugador local sobre la superficie actualizada
            this.player.spawnAtCenter();

            // 3. Sincronizar lista de jugadores online
            if (Array.isArray(payload.players)) {
                for (const p of payload.players) {
                    if (p.id === this.selfId) {
                        if (p.color) this.playerColor = p.color;
                        continue;
                    }
                    this.createOrUpdateRemotePlayer(p);
                }
            }

            if (this.onRemoteBiomeSynced) this.onRemoteBiomeSynced();
            this.notifyStatus();
        });

        this.socket.on('playerJoined', (p) => {
            if (!p || p.id === this.selfId) return;
            this.createOrUpdateRemotePlayer(p);
            this.notifyStatus();
            if (this.onToast) this.onToast(`👋 ${p.name} se unió al mundo`);
        });

        this.socket.on('playerMoved', (p) => {
            if (!p || p.id === this.selfId) return;
            this.createOrUpdateRemotePlayer(p);
        });

        this.socket.on('playerUpdated', (p) => {
            if (!p) return;
            if (p.id === this.selfId) {
                if (p.color) this.playerColor = p.color;
                return;
            }
            this.createOrUpdateRemotePlayer(p);
            this.notifyStatus();
        });

        this.socket.on('playerLeft', (data) => {
            if (!data || !data.id) return;
            this.removeRemotePlayer(data.id);
            this.notifyStatus();
        });

        // Sincronización de bloques individuales y lotes
        this.socket.on('blockMined', (data) => {
            if (!data) return;
            this.world.mineBlock(data.x, data.y, data.z, true, true);
        });

        this.socket.on('blockPlaced', (data) => {
            if (!data || !data.blockId) return;
            if (data.blockDef) {
                this.materialManager.registerCustomBlockDef(data.blockDef);
            }
            this.world.placeBlock(data.x, data.y, data.z, data.blockId, true);
        });

        this.socket.on('blocksBatched', (data) => {
            if (!data || !Array.isArray(data.changes)) return;
            if (data.blockDef) {
                this.materialManager.registerCustomBlockDef(data.blockDef);
            }
            for (const c of data.changes) {
                this.world.setBlock(c.x, c.y, c.z, c.blockId, false);
            }
            this.world.rebuildAllMeshes();
        });

        this.socket.on('materialUpdated', (data) => {
            if (!data) return;
            if (data.skyConfig) {
                Object.assign(this.materialManager.skyConfig, data.skyConfig);
            }
            if (data.blockId && data.changes) {
                this.materialManager.updateBlockAppearance(data.blockId, data.changes);
                this.world.rebuildBlockTypeMesh(data.blockId);
            }
            if (this.onRemoteMaterialSynced) this.onRemoteMaterialSynced();
        });

        this.socket.on('biomeGenerated', (data) => {
            if (!data || !data.biomeParams) return;
            if (data.materials && typeof data.materials === 'object') {
                for (const [bId, def] of Object.entries(data.materials)) {
                    this.materialManager.updateBlockAppearance(bId, def);
                }
            }
            if (data.skyConfig) {
                Object.assign(this.materialManager.skyConfig, data.skyConfig);
            }
            this.world.generateBiome(data.biomeParams, false);
            this.player.spawnAtCenter();
            if (this.onRemoteBiomeSynced) this.onRemoteBiomeSynced();
            if (this.onToast) this.onToast('🌍 Un jugador generó un nuevo Bioma compartido');
        });
    }

    setPlayerName(name) {
        const clean = String(name || '').trim().slice(0, 24);
        if (!clean) return;
        this.playerName = clean;
        localStorage.setItem('shadercraft_nickname', clean);
        if (this.socket && this.connected) {
            this.socket.emit('playerProfile', { name: clean });
        }
        this.notifyStatus();
    }

    getOnlineCount() {
        return (this.connected ? 1 : 1) + this.remotePlayers.size;
    }

    notifyStatus() {
        if (typeof this.onStatusChange === 'function') {
            this.onStatusChange({
                connected: this.connected,
                onlineCount: this.getOnlineCount(),
                playerName: this.playerName,
                remotePlayers: Array.from(this.remotePlayers.values()).map(r => ({
                    id: r.id,
                    name: r.name,
                    color: r.color,
                    mode: r.mode
                }))
            });
        }
    }

    // =========================================================================
    // EMISORES DE EVENTOS AL SERVIDOR
    // =========================================================================
    emitBlockMine(x, y, z) {
        if (!this.socket || !this.connected) return;
        this.socket.emit('blockMine', { x, y, z });
    }

    emitBlockPlace(x, y, z, blockId, blockDef) {
        if (!this.socket || !this.connected) return;
        this.socket.emit('blockPlace', { x, y, z, blockId, blockDef });
    }

    emitBlocksBatch(changes, blockDef) {
        if (!this.socket || !this.connected || !Array.isArray(changes) || changes.length === 0) return;
        this.socket.emit('blocksBatch', { changes, blockDef });
    }

    emitMaterialUpdate(blockId, changes, skyConfig = null) {
        if (!this.socket || !this.connected) return;
        this.socket.emit('materialUpdate', { blockId, changes, skyConfig });
    }

    emitBiomeGenerate(biomeParams, materialsConfig, skyConfig) {
        if (!this.socket || !this.connected) return;
        this.socket.emit('biomeGenerate', {
            biomeParams,
            materials: materialsConfig,
            skyConfig
        });
    }

    // =========================================================================
    // AVATARES 3D DE JUGADORES REMOTOS
    // =========================================================================
    createOrUpdateRemotePlayer(data) {
        let rp = this.remotePlayers.get(data.id);
        if (!rp) {
            rp = this.buildRemoteAvatar(data);
            this.remotePlayers.set(data.id, rp);
            this.remotePlayersGroup.add(rp.group);
        }

        if (data.name && data.name !== rp.name) {
            rp.name = data.name;
            this.updateNameSprite(rp, rp.name, rp.color);
        }
        if (typeof data.x === 'number') rp.targetPos.set(data.x, data.y, data.z);
        if (typeof data.yaw === 'number') rp.targetYaw = data.yaw;
        if (typeof data.pitch === 'number') rp.targetPitch = data.pitch;
        if (data.mode) rp.mode = data.mode;
        if (data.isSwinging) {
            rp.isSwinging = true;
            rp.swingPhase = 0;
        }
        if (data.heldItem && data.heldItem !== rp.heldItem) {
            rp.heldItem = data.heldItem;
            const isPick = rp.heldItem === 'pickaxe';
            rp.pickaxeMesh.visible = isPick;
            rp.heldCubeMesh.visible = !isPick;
            if (!isPick) {
                rp.heldCubeMesh.material = this.materialManager.getMaterial(rp.heldItem);
            }
        }
    }

    removeRemotePlayer(id) {
        const rp = this.remotePlayers.get(id);
        if (!rp) return;
        this.remotePlayersGroup.remove(rp.group);
        this.remotePlayers.delete(id);
    }

    buildRemoteAvatar(data) {
        const group = new THREE.Group();
        const colorHex = data.color || '#38bdf8';

        const skinMat = new THREE.MeshLambertMaterial({ color: 0xf4b998 });
        const hairMat = new THREE.MeshLambertMaterial({ color: 0x27170d });
        const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const eyePupilMat = new THREE.MeshBasicMaterial({ color: 0x1e293b });
        const shirtMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(colorHex) });
        const pantsMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });

        // Cabeza
        const headPivot = new THREE.Group();
        headPivot.position.set(0, 1.32, 0);
        const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.44), skinMat);
        headMesh.position.y = 0.22;
        headMesh.castShadow = true;
        headPivot.add(headMesh);

        const hairTop = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.46), hairMat);
        hairTop.position.set(0, 0.41, 0);
        headPivot.add(hairTop);

        const leftEyeW = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.02), eyeWhiteMat);
        leftEyeW.position.set(-0.1, 0.22, -0.225);
        const leftEyeP = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.025), eyePupilMat);
        leftEyeP.position.set(-0.08, 0.22, -0.228);
        const rightEyeW = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.02), eyeWhiteMat);
        rightEyeW.position.set(0.1, 0.22, -0.225);
        const rightEyeP = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.025), eyePupilMat);
        rightEyeP.position.set(0.08, 0.22, -0.228);
        headPivot.add(leftEyeW, leftEyeP, rightEyeW, rightEyeP);
        group.add(headPivot);

        // Torso
        const torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.66, 0.24), shirtMat);
        torsoMesh.position.set(0, 0.99, 0);
        torsoMesh.castShadow = true;
        group.add(torsoMesh);

        // Brazos
        const leftArmPivot = new THREE.Group();
        leftArmPivot.position.set(-0.34, 1.28, 0);
        const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.56, 0.18), shirtMat);
        leftArm.position.y = -0.24;
        leftArmPivot.add(leftArm);
        group.add(leftArmPivot);

        const rightArmPivot = new THREE.Group();
        rightArmPivot.position.set(0.34, 1.28, 0);
        const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.56, 0.18), shirtMat);
        rightArm.position.y = -0.24;
        rightArmPivot.add(rightArm);

        // Pico y cubo en mano del jugador remoto
        const pickaxeMesh = this.player.createVoxelPickaxeMesh(0.75);
        pickaxeMesh.position.set(0, -0.52, -0.16);
        pickaxeMesh.rotation.x = Math.PI * 0.15;
        rightArmPivot.add(pickaxeMesh);

        const heldCubeMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.28, 0.28, 0.28),
            this.materialManager.getMaterial('grass')
        );
        heldCubeMesh.position.set(0, -0.52, -0.18);
        heldCubeMesh.visible = false;
        rightArmPivot.add(heldCubeMesh);

        group.add(rightArmPivot);

        // Piernas
        const leftLegPivot = new THREE.Group();
        leftLegPivot.position.set(-0.12, 0.66, 0);
        const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.64, 0.21), pantsMat);
        leftLeg.position.y = -0.32;
        leftLegPivot.add(leftLeg);
        group.add(leftLegPivot);

        const rightLegPivot = new THREE.Group();
        rightLegPivot.position.set(0.12, 0.66, 0);
        const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.64, 0.21), pantsMat);
        rightLeg.position.y = -0.32;
        rightLegPivot.add(rightLeg);
        group.add(rightLegPivot);

        // Etiqueta flotante con el nombre (Sprite 2D)
        const nameCanvas = document.createElement('canvas');
        nameCanvas.width = 256;
        nameCanvas.height = 64;
        const nameTex = new THREE.CanvasTexture(nameCanvas);
        const spriteMat = new THREE.SpriteMaterial({ map: nameTex, transparent: true, depthTest: false });
        const nameSprite = new THREE.Sprite(spriteMat);
        nameSprite.position.set(0, 2.15, 0);
        nameSprite.scale.set(1.8, 0.45, 1);
        group.add(nameSprite);

        const startX = typeof data.x === 'number' ? data.x : 0;
        const startY = typeof data.y === 'number' ? data.y : 6;
        const startZ = typeof data.z === 'number' ? data.z : 0;
        group.position.set(startX, startY, startZ);

        const rp = {
            id: data.id,
            name: data.name || 'Jugador',
            color: colorHex,
            mode: data.mode || 'user',
            heldItem: data.heldItem || 'pickaxe',
            group,
            headPivot,
            leftArmPivot,
            rightArmPivot,
            leftLegPivot,
            rightLegPivot,
            pickaxeMesh,
            heldCubeMesh,
            nameCanvas,
            nameTex,
            targetPos: new THREE.Vector3(startX, startY, startZ),
            targetYaw: data.yaw || 0,
            targetPitch: data.pitch || 0,
            walkCycle: 0,
            isSwinging: false,
            swingPhase: 0
        };

        this.updateNameSprite(rp, rp.name, rp.color);
        return rp;
    }

    updateNameSprite(rp, name, color) {
        const ctx = rp.nameCanvas.getContext('2d');
        ctx.clearRect(0, 0, 256, 64);

        ctx.fillStyle = 'rgba(9, 13, 22, 0.78)';
        ctx.beginPath();
        ctx.roundRect(16, 10, 224, 44, 12);
        ctx.fill();

        ctx.strokeStyle = color || '#38bdf8';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 22px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(name).slice(0, 16), 128, 32);

        rp.nameTex.needsUpdate = true;
    }

    update(dt, currentMode) {
        // 1. Emitir posición local al servidor
        if (this.socket && this.connected) {
            this.syncAccumulator += dt;
            if (this.syncAccumulator >= this.syncInterval) {
                this.syncAccumulator = 0;
                const hb = this.player.getActiveHotbarItem();
                const heldItem = hb.type === 'tool' ? 'pickaxe' : this.player.getBlockIdToPlace();
                this.socket.emit('playerUpdate', {
                    x: Number(this.player.position.x.toFixed(2)),
                    y: Number(this.player.position.y.toFixed(2)),
                    z: Number(this.player.position.z.toFixed(2)),
                    yaw: Number(this.player.yaw.toFixed(3)),
                    pitch: Number(this.player.pitch.toFixed(3)),
                    mode: currentMode,
                    heldItem,
                    isSwinging: this.player.isSwinging
                });
            }
        }

        // 2. Interpolar y animar todos los jugadores remotos
        for (const rp of this.remotePlayers.values()) {
            const prevPos = rp.group.position.clone();
            rp.group.position.lerp(rp.targetPos, Math.min(1, dt * 12));
            const movedDist = prevPos.distanceTo(rp.group.position);
            const isWalking = movedDist > 0.008;

            rp.group.rotation.y = rp.targetYaw;
            rp.headPivot.rotation.x = Math.max(-0.6, Math.min(0.6, rp.targetPitch));

            if (isWalking) {
                rp.walkCycle += dt * 10;
            } else {
                rp.walkCycle *= 0.85;
            }

            const legAngle = isWalking ? Math.sin(rp.walkCycle) * 0.65 : 0;
            rp.leftLegPivot.rotation.x = legAngle;
            rp.rightLegPivot.rotation.x = -legAngle;
            rp.leftArmPivot.rotation.x = -legAngle * 0.8;

            let swingOffset = 0;
            if (rp.isSwinging) {
                rp.swingPhase += dt * 15;
                if (rp.swingPhase >= Math.PI) {
                    rp.swingPhase = 0;
                    rp.isSwinging = false;
                }
                swingOffset = Math.sin(rp.swingPhase) * 1.15;
            }
            rp.rightArmPivot.rotation.x = 0.45 + swingOffset + (isWalking && !rp.isSwinging ? legAngle * 0.5 : 0);
        }
    }
}

window.MultiplayerManager = MultiplayerManager;

