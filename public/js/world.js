/**
 * VoxelWorld — Motor de Mundo Voxel 3D de Gran Escala, Generador Procedural de Biomas Amplios,
 * Raycasting DDA exacto, Partículas de Picado, Drops Recolectables y Sincronización Multijugador
 */
class VoxelWorld {
    constructor(scene, materialManager) {
        this.scene = scene;
        this.materialManager = materialManager;

        // Almacenamiento espacial: "x,y,z" -> blockId
        this.voxels = new Map();

        // Callbacks para sincronización multijugador Socket.IO
        this.onBlockMined = null;
        this.onBlockPlaced = null;

        // Grupos de renderizado InstancedMesh por blockId
        this.worldGroup = new THREE.Group();
        this.scene.add(this.worldGroup);
        this.instancedMeshes = new Map(); // blockId -> THREE.InstancedMesh

        // Geometría unitaria compartida para todos los cubos del mundo
        this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
        this.dropGeo = new THREE.BoxGeometry(0.32, 0.32, 0.32);
        this.particleGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);

        // Cubitos tirados en el suelo para agarrar (Drops) y partículas
        this.drops = [];
        this.particles = [];
        this.dropsGroup = new THREE.Group();
        this.particlesGroup = new THREE.Group();
        this.scene.add(this.dropsGroup);
        this.scene.add(this.particlesGroup);

        // Grilla base sutil para referencia visual en Modo Dios
        this.gridHelper = null;

        // Configuración actual del Bioma (Por defecto 64x64 amplio)
        this.biomeParams = {
            preset: 'forest',       // 'forest' | 'mountains' | 'floating' | 'canyon' | 'shader_world' | 'flat'
            size: 64,               // Mundo amplio de 64x64 por defecto (opciones 48, 64, 80, 96)
            hillHeight: 8,          // Altura de relieve (1..16)
            treeDensity: 0.55,      // Densidad de árboles (0..1)
            stoneAbundance: 0.45,   // Afloramientos de piedra y rocas (0..1)
            waterLevel: 2,          // Nivel de agua (0..8)
            seed: 12345
        };

        this.updateGridHelper(this.biomeParams.size);
    }

    key(x, y, z) {
        return `${x | 0},${y | 0},${z | 0}`;
    }

    parseKey(k) {
        const parts = k.split(',');
        return { x: parseInt(parts[0], 10), y: parseInt(parts[1], 10), z: parseInt(parts[2], 10) };
    }

    getBlock(x, y, z) {
        return this.voxels.get(this.key(x, y, z)) || null;
    }

    hasSolidBlock(x, y, z) {
        const b = this.getBlock(x, y, z);
        return b !== null;
    }

    setBlock(x, y, z, blockId, rebuild = true) {
        const k = this.key(x, y, z);
        const prev = this.voxels.get(k);
        if (prev === blockId) return false;

        if (!blockId) {
            if (!prev) return false;
            this.voxels.delete(k);
            if (rebuild) {
                const typesToRebuild = new Set([prev]);
                const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
                for (const [dx, dy, dz] of dirs) {
                    const nb = this.getBlock(x + dx, y + dy, z + dz);
                    if (nb) typesToRebuild.add(nb);
                }
                for (const t of typesToRebuild) this.rebuildBlockTypeMesh(t);
            }
            return true;
        }

        this.voxels.set(k, blockId);
        if (rebuild) {
            if (prev && prev !== blockId) this.rebuildBlockTypeMesh(prev);
            this.rebuildBlockTypeMesh(blockId);
        }
        return true;
    }

    updateGridHelper(size) {
        if (this.gridHelper) {
            this.scene.remove(this.gridHelper);
            this.gridHelper.geometry.dispose();
        }
        const gridSize = Math.max(32, size);
        this.gridHelper = new THREE.GridHelper(gridSize, gridSize, 0x38bdf8, 0x334155);
        this.gridHelper.position.set(0, -0.5, 0);
        this.gridHelper.material.transparent = true;
        this.gridHelper.material.opacity = 0.25;
        this.scene.add(this.gridHelper);
    }

    isCompletelyOccluded(x, y, z) {
        const nb1 = this.voxels.get(`${(x + 1) | 0},${y | 0},${z | 0}`);
        if (!nb1 || nb1 === 'water' || nb1 === 'leaves') return false;
        const nb2 = this.voxels.get(`${(x - 1) | 0},${y | 0},${z | 0}`);
        if (!nb2 || nb2 === 'water' || nb2 === 'leaves') return false;
        const nb3 = this.voxels.get(`${x | 0},${(y + 1) | 0},${z | 0}`);
        if (!nb3 || nb3 === 'water' || nb3 === 'leaves') return false;
        const nb4 = this.voxels.get(`${x | 0},${(y - 1) | 0},${z | 0}`);
        if (!nb4 || nb4 === 'water' || nb4 === 'leaves') return false;
        const nb5 = this.voxels.get(`${x | 0},${y | 0},${(z + 1) | 0}`);
        if (!nb5 || nb5 === 'water' || nb5 === 'leaves') return false;
        const nb6 = this.voxels.get(`${x | 0},${y | 0},${(z - 1) | 0}`);
        if (!nb6 || nb6 === 'water' || nb6 === 'leaves') return false;
        return true;
    }

    buildInstancedMeshForPositions(blockId, positions) {
        const oldMesh = this.instancedMeshes.get(blockId);
        if (oldMesh) {
            this.worldGroup.remove(oldMesh);
            oldMesh.dispose();
            this.instancedMeshes.delete(blockId);
        }

        if (!positions || positions.length === 0) return;

        const mat = this.materialManager.getMaterial(blockId);
        const instMesh = new THREE.InstancedMesh(this.boxGeo, mat, positions.length);
        instMesh.castShadow = blockId !== 'water';
        instMesh.receiveShadow = true;

        const dummy = new THREE.Object3D();
        for (let i = 0; i < positions.length; i++) {
            const p = positions[i];
            dummy.position.set(p.x, p.y, p.z);
            dummy.updateMatrix();
            instMesh.setMatrixAt(i, dummy.matrix);
        }
        instMesh.instanceMatrix.needsUpdate = true;
        this.worldGroup.add(instMesh);
        this.instancedMeshes.set(blockId, instMesh);
    }

    /**
     * Reconstruye únicamente el InstancedMesh de un tipo de bloque específico
     */
    rebuildBlockTypeMesh(blockId) {
        const positions = [];
        for (const [k, bId] of this.voxels.entries()) {
            if (bId !== blockId) continue;
            const { x, y, z } = this.parseKey(k);
            if (this.isCompletelyOccluded(x, y, z)) continue;
            positions.push({ x, y, z });
        }
        this.buildInstancedMeshForPositions(blockId, positions);
    }

    /**
     * Reconstruye todos los InstancedMeshes en una sola pasada O(N) sobre this.voxels
     * para soportar biomas grandes (64x64, 80x80, 96x96) de forma instantánea.
     */
    rebuildAllMeshes() {
        for (const mesh of this.instancedMeshes.values()) {
            this.worldGroup.remove(mesh);
            mesh.dispose();
        }
        this.instancedMeshes.clear();

        const grouped = new Map();
        for (const [k, bId] of this.voxels.entries()) {
            const { x, y, z } = this.parseKey(k);
            if (this.isCompletelyOccluded(x, y, z)) continue;
            let list = grouped.get(bId);
            if (!list) {
                list = [];
                grouped.set(bId, list);
            }
            list.push({ x, y, z });
        }

        for (const [bId, positions] of grouped.entries()) {
            this.buildInstancedMeshForPositions(bId, positions);
        }
    }

    /**
     * Aplica un diccionario de deltas {"x,y,z": blockId | null} recibidos del servidor multijugador
     */
    applyVoxelDeltas(voxelDeltas) {
        if (!voxelDeltas || typeof voxelDeltas !== 'object') return;
        for (const [k, bId] of Object.entries(voxelDeltas)) {
            if (bId === null || bId === undefined || bId === '') {
                this.voxels.delete(k);
            } else {
                this.voxels.set(k, bId);
            }
        }
        this.rebuildAllMeshes();
    }

    /**
     * Pica un bloque en (x, y, z): genera partículas 3D y suelta un mini-cubo recolectable en el piso
     */
    mineBlock(x, y, z, spawnDrop = true, fromRemote = false) {
        const blockId = this.getBlock(x, y, z);
        if (!blockId) return null;

        const def = this.materialManager.getBlockDef(blockId);
        this.setBlock(x, y, z, null, false);

        const typesToRebuild = new Set([blockId]);
        const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        for (const [dx, dy, dz] of dirs) {
            const nb = this.getBlock(x + dx, y + dy, z + dz);
            if (nb) typesToRebuild.add(nb);
        }
        for (const t of typesToRebuild) {
            this.rebuildBlockTypeMesh(t);
        }

        if (!fromRemote && window.voxelAudio) {
            window.voxelAudio.playBlockBreak(def ? def.category : 'stone');
        }

        this.spawnBreakParticles(x, y, z, blockId, fromRemote ? 10 : 16);

        if (spawnDrop) {
            this.spawnDropItem(x, y, z, blockId);
        }

        if (!fromRemote && typeof this.onBlockMined === 'function') {
            this.onBlockMined(x, y, z, blockId);
        }

        return blockId;
    }

    placeBlock(x, y, z, blockId, fromRemote = false) {
        if (!fromRemote && this.hasSolidBlock(x, y, z)) return false;
        const changed = this.setBlock(x, y, z, blockId, true);
        if (!changed) return false;

        if (!fromRemote && window.voxelAudio) {
            window.voxelAudio.playBlockPlace();
        }

        if (!fromRemote && typeof this.onBlockPlaced === 'function') {
            const blockDef = this.materialManager.getBlockDef(blockId);
            this.onBlockPlaced(x, y, z, blockId, blockDef);
        }
        return true;
    }

    spawnBreakParticles(x, y, z, blockId, count = 16) {
        const mat = this.materialManager.getMaterial(blockId);
        for (let i = 0; i < count; i++) {
            const mesh = new THREE.Mesh(this.particleGeo, mat);
            mesh.position.set(
                x + (Math.random() - 0.5) * 0.7,
                y + (Math.random() - 0.5) * 0.7,
                z + (Math.random() - 0.5) * 0.7
            );
            this.particlesGroup.add(mesh);
            this.particles.push({
                mesh,
                vx: (Math.random() - 0.5) * 4.2,
                vy: 1.5 + Math.random() * 3.5,
                vz: (Math.random() - 0.5) * 4.2,
                rx: (Math.random() - 0.5) * 10,
                ry: (Math.random() - 0.5) * 10,
                life: 0.45 + Math.random() * 0.35
            });
        }
    }

    spawnDropItem(x, y, z, blockId) {
        const mat = this.materialManager.getMaterial(blockId);
        const mesh = new THREE.Mesh(this.dropGeo, mat);
        mesh.position.set(x, y + 0.1, z);
        mesh.castShadow = true;

        this.dropsGroup.add(mesh);
        this.drops.push({
            mesh,
            blockId,
            x,
            y: y + 0.1,
            z,
            vx: (Math.random() - 0.5) * 1.6,
            vy: 3.2 + Math.random() * 1.2,
            vz: (Math.random() - 0.5) * 1.6,
            age: 0,
            magnetized: false
        });
    }

    /**
     * Actualiza física de partículas y cubitos tirados (Drops), y verifica si el jugador los agarra
     */
    updateEntities(dt, playerPos, onPickupCallback) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= dt;
            if (p.life <= 0) {
                this.particlesGroup.remove(p.mesh);
                this.particles.splice(i, 1);
                continue;
            }
            p.vy -= 14.0 * dt;
            p.mesh.position.x += p.vx * dt;
            p.mesh.position.y += p.vy * dt;
            p.mesh.position.z += p.vz * dt;
            p.mesh.rotation.x += p.rx * dt;
            p.mesh.rotation.y += p.ry * dt;
            const s = Math.max(0.01, p.life * 1.6);
            p.mesh.scale.setScalar(Math.min(1, s));
        }

        for (let i = this.drops.length - 1; i >= 0; i--) {
            const d = this.drops[i];
            d.age += dt;

            d.mesh.rotation.y += 2.4 * dt;
            d.mesh.rotation.x = Math.sin(d.age * 3.0) * 0.18;

            if (!d.magnetized) {
                d.vy -= 15.0 * dt;
                d.x += d.vx * dt;
                d.y += d.vy * dt;
                d.z += d.vz * dt;
                d.vx *= 0.92;
                d.vz *= 0.92;

                const bx = Math.round(d.x);
                const by = Math.floor(d.y - 0.2);
                const bz = Math.round(d.z);
                if (this.hasSolidBlock(bx, by, bz) && d.vy < 0) {
                    d.y = by + 0.72;
                    d.vy = 0;
                    d.vx *= 0.7;
                    d.vz *= 0.7;
                }
            }

            if (playerPos && d.age > 0.22) {
                const targetX = playerPos.x;
                const targetY = playerPos.y + 0.85;
                const targetZ = playerPos.z;
                const dx = targetX - d.x;
                const dy = targetY - d.y;
                const dz = targetZ - d.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (dist < 2.85) {
                    d.magnetized = true;
                    const pullSpeed = 11.5;
                    d.x += (dx / Math.max(0.05, dist)) * pullSpeed * dt;
                    d.y += (dy / Math.max(0.05, dist)) * pullSpeed * dt;
                    d.z += (dz / Math.max(0.05, dist)) * pullSpeed * dt;

                    if (dist < 0.65) {
                        this.dropsGroup.remove(d.mesh);
                        this.drops.splice(i, 1);
                        if (window.voxelAudio) window.voxelAudio.playPickupPop();
                        if (onPickupCallback) onPickupCallback(d.blockId);
                        continue;
                    }
                } else {
                    d.magnetized = false;
                }
            }

            const bob = d.magnetized ? 0 : Math.sin(d.age * 4.0) * 0.07;
            d.mesh.position.set(d.x, d.y + bob, d.z);

            if (d.y < -30 || d.age > 120) {
                this.dropsGroup.remove(d.mesh);
                this.drops.splice(i, 1);
            }
        }
    }

    /**
     * Raycast Voxel DDA (Amanatides & Woo) exacto sobre la grilla de cubos.
     */
    raycast(origin, direction, maxDist = 90, floorPlaneY = null) {
        const ox = origin.x + 0.5;
        const oy = origin.y + 0.5;
        const oz = origin.z + 0.5;

        const dx = direction.x;
        const dy = direction.y;
        const dz = direction.z;

        let ix = Math.floor(ox);
        let iy = Math.floor(oy);
        let iz = Math.floor(oz);

        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;

        const txDelta = Math.abs(dx) > 1e-8 ? Math.abs(1 / dx) : 1e30;
        const tyDelta = Math.abs(dy) > 1e-8 ? Math.abs(1 / dy) : 1e30;
        const tzDelta = Math.abs(dz) > 1e-8 ? Math.abs(1 / dz) : 1e30;

        const xDist = stepX > 0 ? (ix + 1 - ox) : (ox - ix);
        const yDist = stepY > 0 ? (iy + 1 - oy) : (oy - iy);
        const zDist = stepZ > 0 ? (iz + 1 - oz) : (oz - iz);

        let txMax = txDelta < 1e29 ? txDelta * xDist : 1e30;
        let tyMax = tyDelta < 1e29 ? tyDelta * yDist : 1e30;
        let tzMax = tzDelta < 1e29 ? tzDelta * zDist : 1e30;

        let t = 0;
        let steppedIndex = -1;

        while (t <= maxDist) {
            const blockId = this.getBlock(ix, iy, iz);
            if (blockId) {
                const normal = { x: 0, y: 0, z: 0 };
                if (steppedIndex === 0) normal.x = -stepX;
                else if (steppedIndex === 1) normal.y = -stepY;
                else if (steppedIndex === 2) normal.z = -stepZ;
                else normal.y = 1;

                return {
                    hit: true,
                    isPlane: false,
                    blockId,
                    voxel: { x: ix, y: iy, z: iz },
                    normal,
                    placePos: {
                        x: ix + normal.x,
                        y: iy + normal.y,
                        z: iz + normal.z
                    },
                    distance: t
                };
            }

            if (txMax < tyMax) {
                if (txMax < tzMax) {
                    ix += stepX;
                    t = txMax;
                    txMax += txDelta;
                    steppedIndex = 0;
                } else {
                    iz += stepZ;
                    t = tzMax;
                    tzMax += tzDelta;
                    steppedIndex = 2;
                }
            } else {
                if (tyMax < tzMax) {
                    iy += stepY;
                    t = tyMax;
                    tyMax += tyDelta;
                    steppedIndex = 1;
                } else {
                    iz += stepZ;
                    t = tzMax;
                    tzMax += tzDelta;
                    steppedIndex = 2;
                }
            }
        }

        if (floorPlaneY !== null && Math.abs(dy) > 1e-5) {
            const planeY = floorPlaneY - 0.5;
            const tPlane = (planeY - origin.y) / dy;
            if (tPlane > 0 && tPlane <= maxDist * 1.5) {
                const hx = Math.round(origin.x + dx * tPlane);
                const hz = Math.round(origin.z + dz * tPlane);
                const half = Math.ceil(this.biomeParams.size / 2) + 12;
                if (Math.abs(hx) <= half && Math.abs(hz) <= half) {
                    return {
                        hit: true,
                        isPlane: true,
                        blockId: null,
                        voxel: { x: hx, y: floorPlaneY - 1, z: hz },
                        normal: { x: 0, y: 1, z: 0 },
                        placePos: { x: hx, y: floorPlaneY, z: hz },
                        distance: tPlane
                    };
                }
            }
        }

        return null;
    }

    /**
     * Encuentra la coordenada Y libre más alta en (x, z) para posicionar al personaje
     */
    getHighestY(x, z) {
        const rx = Math.round(x);
        const rz = Math.round(z);
        for (let y = 55; y >= -15; y--) {
            const b = this.getBlock(rx, y, rz);
            if (b && b !== 'leaves') {
                return y + 1;
            }
        }
        return 5;
    }

    // =========================================================================
    // GENERADOR PROCEDURAL DE BIOMAS AMPLIOS (48x48, 64x64, 80x80, 96x96)
    // =========================================================================
    generateBiome(customParams = {}, silentAudio = false) {
        Object.assign(this.biomeParams, customParams);
        // Asegurar un tamaño mínimo amplio (>= 48) salvo que se fuerce explícitamente
        if (!this.biomeParams.size || this.biomeParams.size < 36) {
            this.biomeParams.size = 64;
        }

        const {
            preset,
            size,
            hillHeight,
            treeDensity,
            stoneAbundance,
            waterLevel,
            seed
        } = this.biomeParams;

        // Si el usuario eligió el preset "Bioma Shader Viva", activamos shaders 1-buffer orgánicos sin líneas
        if (preset === 'shader_world') {
            this.materialManager.updateBlockAppearance('grass', { mode: 'shader', shaderKind: 'builtin', shaderValue: 'bio_forest', emissive: true });
            this.materialManager.updateBlockAppearance('stone', { mode: 'shader', shaderKind: 'builtin', shaderValue: 'runic_stone', emissive: true });
            this.materialManager.updateBlockAppearance('water', { mode: 'shader', shaderKind: 'builtin', shaderValue: 'water_caustics', emissive: true });
            this.materialManager.updateBlockAppearance('leaves', { mode: 'shader', shaderKind: 'builtin', shaderValue: 'plasma_neon', emissive: true });
        }

        this.voxels.clear();
        for (const d of this.drops) this.dropsGroup.remove(d.mesh);
        for (const p of this.particles) this.particlesGroup.remove(p.mesh);
        this.drops = [];
        this.particles = [];

        this.updateGridHelper(size);

        const half = Math.floor(size / 2);

        let s = (Number(seed) || 12345) & 0x7fffffff;
        if (s <= 0) s = 12345;
        const rand = () => {
            s = (s * 48271) % 2147483647;
            return (s - 1) / 2147483646;
        };

        const hash2 = (x, z) => {
            const n = Math.sin(x * 127.1 + z * 311.7 + (Number(seed) || 12345) * 0.13) * 43758.5453123;
            return n - Math.floor(n);
        };
        const smoothNoise = (x, z) => {
            const ix = Math.floor(x), iz = Math.floor(z);
            const fx = x - ix, fz = z - iz;
            const ux = fx * fx * (3 - 2 * fx);
            const uz = fz * fz * (3 - 2 * fz);
            const a = hash2(ix, iz);
            const b = hash2(ix + 1, iz);
            const c = hash2(ix, iz + 1);
            const d = hash2(ix + 1, iz + 1);
            return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
        };
        const fbm = (x, z) => {
            let v = 0, amp = 0.5, freq = 1;
            for (let i = 0; i < 3; i++) {
                v += amp * smoothNoise(x * freq, z * freq);
                freq *= 2.02;
                amp *= 0.5;
            }
            return v;
        };

        const surfaceMap = new Map();

        for (let x = -half; x < half; x++) {
            for (let z = -half; z < half; z++) {
                const distFromCenter = Math.sqrt(x * x + z * z) / half;
                const isPerimeter = (x === -half || x === half - 1 || z === -half || z === half - 1);

                if (preset === 'flat') {
                    this.voxels.set(this.key(x, 0, z), 'stone');
                    this.voxels.set(this.key(x, 1, z), 'dirt');
                    this.voxels.set(this.key(x, 2, z), 'grass');
                    surfaceMap.set(`${x},${z}`, { h: 2, top: 'grass' });
                    continue;
                }

                if (preset === 'floating') {
                    const islandMask = fbm(x * 0.06, z * 0.06) - distFromCenter * 0.45;
                    if (islandMask < 0.12) continue;
                    const topH = Math.round(4 + fbm(x * 0.08, z * 0.08) * hillHeight);
                    const bottomH = Math.max(0, Math.round(topH - Math.min(4, (islandMask - 0.1) * 10)));
                    for (let y = bottomH; y <= topH; y++) {
                        if (y === topH) {
                            const isRock = fbm(x * 0.22 + 9, z * 0.22 + 9) > (1.02 - stoneAbundance * 0.45);
                            const topBlock = isRock ? 'stone' : 'grass';
                            this.voxels.set(this.key(x, y, z), topBlock);
                            surfaceMap.set(`${x},${z}`, { h: y, top: topBlock });
                        } else if (y >= topH - 1) {
                            this.voxels.set(this.key(x, y, z), 'dirt');
                        } else {
                            this.voxels.set(this.key(x, y, z), 'stone');
                        }
                    }
                    continue;
                }

                // Terreno amplio con colinas suaves y valles
                let n = fbm(x * 0.052, z * 0.052);
                if (preset === 'mountains') {
                    n = Math.pow(n, 1.3) * 1.5;
                } else if (preset === 'canyon') {
                    n = Math.floor(n * 5) / 5;
                }

                const h = Math.max(1, Math.round(1 + n * hillHeight));
                // Generamos las capas superficiales + subsuelo cercano (y el borde completo en el perímetro)
                const minY = isPerimeter ? 0 : Math.max(0, h - 3);

                for (let y = minY; y <= h; y++) {
                    if (y === h) {
                        let topBlock = 'grass';
                        const rockNoise = fbm(x * 0.2 + 30, z * 0.2 + 30);

                        if (preset === 'canyon') {
                            topBlock = y > waterLevel + 2 ? 'dirt' : 'sand';
                        } else if (y <= waterLevel && waterLevel > 0) {
                            topBlock = 'sand';
                        } else if (
                            (preset === 'mountains' && y >= hillHeight * 0.72) ||
                            rockNoise > (0.95 - stoneAbundance * 0.42)
                        ) {
                            topBlock = 'stone';
                        }
                        this.voxels.set(this.key(x, y, z), topBlock);
                        surfaceMap.set(`${x},${z}`, { h, top: topBlock });
                    } else if (y >= h - 1) {
                        this.voxels.set(this.key(x, y, z), preset === 'canyon' ? 'sand' : 'dirt');
                    } else {
                        this.voxels.set(this.key(x, y, z), 'stone');
                    }
                }

                if (waterLevel > 0 && h < waterLevel) {
                    for (let wy = h + 1; wy <= waterLevel; wy++) {
                        this.voxels.set(this.key(x, wy, z), 'water');
                    }
                }
            }
        }

        // Generar afloramientos de piedra / rocas superficiales (Boulders)
        const numBoulders = Math.floor((size * size) * 0.006 * stoneAbundance);
        for (let b = 0; b < numBoulders; b++) {
            const bx = Math.floor((rand() - 0.5) * (size - 4));
            const bz = Math.floor((rand() - 0.5) * (size - 4));
            const surf = surfaceMap.get(`${bx},${bz}`);
            if (!surf || surf.h <= waterLevel) continue;
            this.buildBoulder(bx, surf.h + 1, bz, rand);
        }

        // Generar Árboles de Minecraft (Troncos de Madera + Copa de Hojas)
        const treePositions = [];
        const maxTrees = Math.floor((size * size) * 0.024 * treeDensity);

        for (let attempt = 0; attempt < maxTrees * 5 && treePositions.length < maxTrees; attempt++) {
            const tx = Math.floor((rand() - 0.5) * (size - 6));
            const tz = Math.floor((rand() - 0.5) * (size - 6));

            if (Math.abs(tx) <= 2 && Math.abs(tz) <= 2) continue;

            const surf = surfaceMap.get(`${tx},${tz}`);
            if (!surf) continue;
            if (surf.top !== 'grass' && !(preset === 'canyon' && surf.top === 'dirt')) continue;
            if (waterLevel > 0 && surf.h <= waterLevel) continue;

            const tooClose = treePositions.some(p => {
                const dx = p.x - tx, dz = p.z - tz;
                return Math.sqrt(dx * dx + dz * dz) < 4.5;
            });
            if (tooClose) continue;

            treePositions.push({ x: tx, z: tz });
            const style = preset === 'mountains' && rand() > 0.35 ? 'pine' : 'oak';
            this.buildTree(tx, surf.h + 1, tz, style, rand);
        }

        this.rebuildAllMeshes();
        if (!silentAudio && window.voxelAudio) {
            window.voxelAudio.playBiomeGenerate();
        }
    }

    buildBoulder(x, y, z, rand) {
        this.voxels.set(this.key(x, y, z), 'stone');
        if (rand() > 0.35) this.voxels.set(this.key(x + 1, y, z), 'stone');
        if (rand() > 0.35) this.voxels.set(this.key(x, y, z + 1), 'stone');
        if (rand() > 0.5) this.voxels.set(this.key(x, y + 1, z), 'stone');
    }

    buildTree(x, baseY, z, style = 'oak', rand) {
        const trunkHeight = style === 'pine'
            ? 5 + Math.floor(rand() * 2)
            : 4 + Math.floor(rand() * 2);

        for (let ty = 0; ty < trunkHeight; ty++) {
            this.voxels.set(this.key(x, baseY + ty, z), 'wood');
        }

        const topY = baseY + trunkHeight;

        if (style === 'pine') {
            for (let layer = -2; layer <= 1; layer++) {
                const radius = layer <= -1 ? 2 : 1;
                const ly = topY + layer;
                for (let lx = -radius; lx <= radius; lx++) {
                    for (let lz = -radius; lz <= radius; lz++) {
                        if (Math.abs(lx) === radius && Math.abs(lz) === radius && radius > 1) continue;
                        if (lx === 0 && lz === 0 && layer < 1) continue;
                        this.voxels.set(this.key(x + lx, ly, z + lz), 'leaves');
                    }
                }
            }
            this.voxels.set(this.key(x, topY + 2, z), 'leaves');
        } else {
            for (let ly = topY - 2; ly <= topY + 1; ly++) {
                const isUpper = ly >= topY;
                const radius = isUpper ? 1 : 2;
                for (let lx = -radius; lx <= radius; lx++) {
                    for (let lz = -radius; lz <= radius; lz++) {
                        if (lx === 0 && lz === 0 && ly < topY) continue;
                        if (Math.abs(lx) === radius && Math.abs(lz) === radius) {
                            if (isUpper && ly === topY + 1) continue;
                            if (!isUpper && rand() > 0.45) continue;
                        }
                        if (!this.voxels.has(this.key(x + lx, ly, z + lz))) {
                            this.voxels.set(this.key(x + lx, ly, z + lz), 'leaves');
                        }
                    }
                }
            }
        }
    }

    serializeWorld() {
        const blocksArray = [];
        for (const [k, bId] of this.voxels.entries()) {
            const { x, y, z } = this.parseKey(k);
            blocksArray.push([x, y, z, bId]);
        }
        return {
            version: 1,
            timestamp: new Date().toISOString(),
            biomeParams: { ...this.biomeParams },
            materials: this.materialManager.serializeConfig(),
            voxels: blocksArray
        };
    }

    deserializeWorld(data) {
        if (!data || !Array.isArray(data.voxels)) return false;
        if (data.materials) {
            this.materialManager.deserializeConfig(data.materials);
        }
        if (data.biomeParams) {
            Object.assign(this.biomeParams, data.biomeParams);
            this.updateGridHelper(this.biomeParams.size);
        }
        this.voxels.clear();
        for (const item of data.voxels) {
            if (Array.isArray(item) && item.length >= 4) {
                this.voxels.set(this.key(item[0], item[1], item[2]), item[3]);
            }
        }
        this.rebuildAllMeshes();
        return true;
    }
}

window.VoxelWorld = VoxelWorld;
