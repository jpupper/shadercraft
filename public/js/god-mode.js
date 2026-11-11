/**
 * GodModeController — Modo Dios ("desde arriba podes poner cubitos, elegir el color o shader 1-buffer")
 * ----------------------------------------------------------------------------------------------------
 * - Cámara Cenital / Isométrica / Orbital desde arriba con paneo WASD, subida/bajada con E y Q, rotación y zoom
 * - Vista previa fantasma 3D (Ghost Preview) para pinceles 1x1, 2x2, 3x3 y Columna
 * - Herramientas: Poner Cubo, Borrar Cubo, Pintar Material/Shader sobre cubo existente,
 *   Cuentagotas y Teletransportar Personaje
 * - Sincronización en tiempo real de trazos por lotes hacia el servidor Multijugador Socket.IO
 */
class GodModeController {
    constructor(scene, camera, domElement, world, materialManager, player) {
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement;
        this.world = world;
        this.materialManager = materialManager;
        this.player = player;

        // Estado de cámara orbital desde arriba
        this.target = new THREE.Vector3(0, 6, 0);
        this.radius = 44;
        this.theta = Math.PI * 0.25; // Ángulo horizontal
        this.phi = 0.52;             // Ángulo desde la vertical (0.05 = cenital puro, 0.65 = isométrica)

        // Herramienta activa en Modo Dios
        this.tool = 'place';         // 'place' | 'erase' | 'paint' | 'pick' | 'teleport'
        this.brushSize = 1;          // 1 | 2 | 3 | 'column'
        this.sourceMode = 'brush';   // 'brush' (usa el Color/Shader del panel) | 'hotbar' (usa el bloque de la hotbar)
        this.lockYEnabled = false;
        this.lockedYValue = 4;

        // Interacción de mouse
        this.mouseNDC = new THREE.Vector2(0, 0);
        this.isOrbiting = false;
        this.isPanning = false;
        this.isPaintingStroke = false;
        this.strokeLockedY = null;
        this.lastStrokeVoxelKey = null;
        this.lastMouse = { x: 0, y: 0 };

        this.currentHit = null;
        this.onBrushPicked = null;
        this.onCoordsUpdate = null;
        this.onHeightChange = null;
        this.onGodBatchChanges = null;

        this.buildGhostPreview();
    }

    buildGhostPreview() {
        this.ghostGroup = new THREE.Group();
        this.ghostGroup.visible = false;
        this.scene.add(this.ghostGroup);

        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03));
        this.ghostWireMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.95 });
        this.ghostWire = new THREE.LineSegments(edges, this.ghostWireMat);
        this.ghostGroup.add(this.ghostWire);

        this.ghostMeshGeo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
        this.ghostMeshMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.55
        });
        this.ghostMesh = new THREE.Mesh(this.ghostMeshGeo, this.ghostMeshMat);
        this.ghostGroup.add(this.ghostMesh);
    }

    enterGodMode() {
        this.target.set(this.player.position.x, Math.max(4, this.player.position.y), this.player.position.z);
        this.updateCameraTransform();
        this.ghostGroup.visible = true;
        if (this.onHeightChange) {
            this.onHeightChange(this.target.y, this.lockedYValue);
        }
    }

    exitGodMode() {
        this.ghostGroup.visible = false;
        this.isOrbiting = false;
        this.isPanning = false;
        this.isPaintingStroke = false;
    }

    setCameraPreset(preset) {
        if (preset === 'top') {
            this.phi = 0.08;
            this.radius = 48;
        } else if (preset === 'iso') {
            this.phi = 0.68;
            this.theta = Math.PI * 0.25;
            this.radius = 46;
        } else if (preset === 'close') {
            this.phi = 0.50;
            this.radius = 22;
        }
        this.updateCameraTransform();
    }

    /**
     * Permite subir o bajar la altura en pasos discretos (y ajusta también lockedYValue si está activo)
     */
    adjustHeightStep(deltaY) {
        this.target.y = Math.max(-10, Math.min(80, this.target.y + deltaY));
        if (this.lockYEnabled) {
            this.lockedYValue = Math.max(-5, Math.min(50, Math.round(this.lockedYValue + deltaY)));
        }
        this.updateCameraTransform();
        if (this.onHeightChange) {
            this.onHeightChange(this.target.y, this.lockedYValue);
        }
    }

    updateCameraTransform() {
        const sinPhi = Math.sin(this.phi);
        const cosPhi = Math.cos(this.phi);
        const x = this.target.x + this.radius * sinPhi * Math.sin(this.theta);
        const y = this.target.y + this.radius * cosPhi;
        const z = this.target.z + this.radius * sinPhi * Math.cos(this.theta);

        this.camera.position.set(x, y, z);
        this.camera.lookAt(this.target);
    }

    getActiveBlockIdForGod() {
        const hbItem = this.player.getActiveHotbarItem();
        if (this.sourceMode === 'hotbar' && hbItem && hbItem.type === 'block') {
            return hbItem.id;
        }
        const def = this.materialManager.getOrCreateBrushBlock();
        return def.id;
    }

    getFootprintOffsets() {
        if (this.brushSize === 'column') {
            return [
                { dx: 0, dy: 0, dz: 0 },
                { dx: 0, dy: 1, dz: 0 },
                { dx: 0, dy: 2, dz: 0 },
                { dx: 0, dy: 3, dz: 0 }
            ];
        }
        const size = Number(this.brushSize) || 1;
        if (size === 1) return [{ dx: 0, dy: 0, dz: 0 }];
        const offsets = [];
        const start = -Math.floor((size - 1) / 2);
        const end = start + size - 1;
        for (let dx = start; dx <= end; dx++) {
            for (let dz = start; dz <= end; dz++) {
                offsets.push({ dx, dy: 0, dz });
            }
        }
        return offsets;
    }

    update(dt, isGodModeActive) {
        if (!isGodModeActive) {
            this.ghostGroup.visible = false;
            return;
        }

        // 1. Paneo horizontal con WASD/Flechas y Subir/Bajar en altura con E (up) y Q (down)
        const keys = this.player.keys;
        const panForward = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
        const panRight = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
        const panVertical = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);

        if (panForward !== 0 || panRight !== 0 || panVertical !== 0) {
            const panSpeed = (keys.sprint ? 34 : 20) * dt;
            const forward = new THREE.Vector3(-Math.sin(this.theta), 0, -Math.cos(this.theta));
            const right = new THREE.Vector3(Math.cos(this.theta), 0, -Math.sin(this.theta));
            this.target.addScaledVector(forward, panForward * panSpeed);
            this.target.addScaledVector(right, panRight * panSpeed);

            if (panVertical !== 0) {
                const vertSpeed = (keys.sprint ? 26 : 16) * dt;
                this.target.y = Math.max(-10, Math.min(80, this.target.y + panVertical * vertSpeed));
                if (this.onHeightChange) {
                    this.onHeightChange(this.target.y, this.lockedYValue);
                }
            }
        }

        this.updateCameraTransform();

        // 2. Raycast desde el puntero del mouse hacia el mundo
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(this.mouseNDC, this.camera);
        const origin = raycaster.ray.origin;
        const dir = raycaster.ray.direction;

        if (this.lockYEnabled && Math.abs(dir.y) > 1e-4) {
            const t = (this.lockedYValue - origin.y) / dir.y;
            if (t > 0 && t < 240) {
                const hx = Math.round(origin.x + dir.x * t);
                const hz = Math.round(origin.z + dir.z * t);
                this.currentHit = {
                    hit: true,
                    isPlane: true,
                    blockId: this.world.getBlock(hx, this.lockedYValue, hz),
                    voxel: { x: hx, y: this.lockedYValue, z: hz },
                    normal: { x: 0, y: 1, z: 0 },
                    placePos: { x: hx, y: this.lockedYValue, z: hz }
                };
            } else {
                this.currentHit = null;
            }
        } else {
            const planeY = this.strokeLockedY !== null ? this.strokeLockedY : 0;
            this.currentHit = this.world.raycast(origin, dir, 180, planeY);
        }

        // 3. Actualizar Ghost Preview 3D
        if (this.currentHit) {
            const isTargetExisting = (this.tool === 'erase' || this.tool === 'paint' || this.tool === 'pick');
            const pos = isTargetExisting ? this.currentHit.voxel : this.currentHit.placePos;

            const finalY = (this.isPaintingStroke && this.strokeLockedY !== null && this.tool === 'place')
                ? this.strokeLockedY
                : pos.y;

            this.ghostGroup.position.set(pos.x, finalY, pos.z);
            this.ghostGroup.visible = true;

            if (this.brushSize === 'column' && this.tool === 'place') {
                this.ghostGroup.scale.set(1, 4, 1);
                this.ghostGroup.position.y = finalY + 1.5;
            } else {
                const s = Number(this.brushSize) || 1;
                this.ghostGroup.scale.set(s, 1, s);
                if (s === 2) {
                    this.ghostGroup.position.x = pos.x + 0.5;
                    this.ghostGroup.position.z = pos.z + 0.5;
                }
            }

            if (this.tool === 'erase') {
                this.ghostWireMat.color.setHex(0xf43f5e);
                this.ghostMeshMat.color.setHex(0xf43f5e);
            } else if (this.tool === 'paint') {
                this.ghostWireMat.color.setHex(0xa855f7);
                this.ghostMeshMat.color.set(this.materialManager.activeBrush.color || '#a855f7');
            } else if (this.tool === 'teleport') {
                this.ghostWireMat.color.setHex(0x22c55e);
                this.ghostMeshMat.color.setHex(0x22c55e);
            } else {
                this.ghostWireMat.color.setHex(0x38bdf8);
                const bId = this.getActiveBlockIdForGod();
                const def = this.materialManager.getBlockDef(bId);
                this.ghostMeshMat.color.set(def && def.color ? def.color : '#38bdf8');
            }

            if (this.onCoordsUpdate) {
                this.onCoordsUpdate(pos.x, finalY, pos.z, this.currentHit.blockId);
            }
        } else {
            this.ghostGroup.visible = false;
        }
    }

    /**
     * Ejecuta la acción de Modo Dios en la posición actual del cursor
     */
    executeGodAction() {
        if (!this.currentHit) return;

        if (this.tool === 'teleport') {
            const p = this.currentHit.placePos;
            this.player.position.set(p.x, p.y + 0.05, p.z);
            this.player.velocity.set(0, 0, 0);
            this.player.updateCharacterVisuals(0, false);
            if (window.voxelAudio) window.voxelAudio.playPickupPop();
            return;
        }

        if (this.tool === 'pick') {
            const bId = this.currentHit.blockId;
            if (!bId) return;
            const def = this.materialManager.getBlockDef(bId);
            if (def) {
                this.materialManager.activeBrush.mode = def.mode === 'shader' ? 'shader' : 'color';
                this.materialManager.activeBrush.color = def.color || '#38bdf8';
                this.materialManager.activeBrush.pattern = def.pattern || 'solid';
                if (def.mode === 'shader') {
                    this.materialManager.activeBrush.shaderKind = def.shaderKind || 'shader';
                    this.materialManager.activeBrush.shaderValue = def.shaderValue;
                    this.materialManager.activeBrush.shaderTitle = def.shaderTitle || def.shaderValue;
                }
                this.sourceMode = 'brush';
                if (this.onBrushPicked) this.onBrushPicked(def);
            }
            return;
        }

        const isTargetExisting = (this.tool === 'erase' || this.tool === 'paint');
        const basePos = isTargetExisting ? this.currentHit.voxel : this.currentHit.placePos;
        const baseY = (this.isPaintingStroke && this.strokeLockedY !== null && this.tool === 'place')
            ? this.strokeLockedY
            : basePos.y;

        const strokeKey = `${basePos.x},${baseY},${basePos.z}`;
        if (this.isPaintingStroke && this.lastStrokeVoxelKey === strokeKey) return;
        this.lastStrokeVoxelKey = strokeKey;

        if (this.strokeLockedY === null && this.tool === 'place') {
            this.strokeLockedY = baseY;
        }

        const offsets = this.getFootprintOffsets();
        const blockId = this.getActiveBlockIdForGod();
        const affectedTypes = new Set();
        const batchChanges = [];

        for (const { dx, dy, dz } of offsets) {
            const vx = basePos.x + dx;
            const vy = baseY + dy;
            const vz = basePos.z + dz;

            if (this.tool === 'erase') {
                const old = this.world.getBlock(vx, vy, vz);
                if (old) {
                    affectedTypes.add(old);
                    this.world.setBlock(vx, vy, vz, null, false);
                    this.world.spawnBreakParticles(vx, vy, vz, old, 6);
                    batchChanges.push({ x: vx, y: vy, z: vz, blockId: null });
                }
            } else if (this.tool === 'paint') {
                const old = this.world.getBlock(vx, vy, vz);
                if (old) {
                    affectedTypes.add(old);
                    affectedTypes.add(blockId);
                    this.world.setBlock(vx, vy, vz, blockId, false);
                    batchChanges.push({ x: vx, y: vy, z: vz, blockId });
                }
            } else if (this.tool === 'place') {
                if (!this.world.hasSolidBlock(vx, vy, vz)) {
                    affectedTypes.add(blockId);
                    this.world.setBlock(vx, vy, vz, blockId, false);
                    batchChanges.push({ x: vx, y: vy, z: vz, blockId });
                }
            }
        }

        if (affectedTypes.size > 0) {
            this.world.rebuildAllMeshes();
            if (window.voxelAudio) {
                if (this.tool === 'erase') window.voxelAudio.playBlockBreak('stone');
                else window.voxelAudio.playBlockPlace();
            }
            if (batchChanges.length > 0 && typeof this.onGodBatchChanges === 'function') {
                const blockDef = this.materialManager.getBlockDef(blockId);
                this.onGodBatchChanges(batchChanges, blockDef);
            }
        }
    }
}

window.GodModeController = GodModeController;
