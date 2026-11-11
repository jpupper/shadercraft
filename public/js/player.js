/**
 * PlayerController — Personaje 3D estilo Minecraft con Pico Voxel 3D,
 * Física AABB 3D, Desplazamiento Caminando y Vuelo 3D, Cámara 1ª/3ª Persona,
 * Sistema de Picado con Progreso, Recolección de Cubos e Inventario Completo.
 */
class PlayerController {
    constructor(scene, camera, domElement, world, materialManager) {
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement;
        this.world = world;
        this.materialManager = materialManager;

        // Estado de posición y física
        this.position = new THREE.Vector3(0, 8, 0); // Posición de los pies
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.width = 0.62;
        this.height = 1.72;
        this.eyeHeight = 1.52;

        // Orientación de mirada
        this.yaw = 0;
        this.pitch = -0.22;

        // Modos de movimiento y vista en Modo Juego
        this.isFlying = false;          // F: Desplazamiento libre en 3D (Vuelo) vs Gravedad
        this.thirdPerson = true;        // V: Arranca viendo al personaje con el pico (se alterna con 1ª persona)
        this.thirdPersonDist = 4.6;
        this.onGround = false;

        // Estado de controles (incluye Q/E para bajar/subir en Modo Dios y Vuelo)
        this.keys = {
            forward: false,
            backward: false,
            left: false,
            right: false,
            jump: false,
            descend: false,
            up: false,
            down: false,
            sprint: false
        };
        this.isPointerLocked = false;
        this.isDraggingLook = false;
        this.dragMoved = false;
        this.lastMouse = { x: 0, y: 0 };

        // Estado de picado con el Pico
        this.isMining = false;
        this.miningTargetKey = null;
        this.miningProgress = 0;
        this.miningDuration = 0.26;
        this.swingPhase = 0;
        this.isSwinging = false;
        this.walkCycle = 0;
        this.stepAccumulator = 0;

        // Bloque apuntado actualmente
        this.targetedHit = null;

        // Almacén completo del Inventario (blockId -> cantidad disponible)
        this.inventoryCounts = new Map([
            ['grass', 64],
            ['stone', 64],
            ['wood', 64],
            ['leaves', 64],
            ['dirt', 64],
            ['water', 64],
            ['sand', 64]
        ]);

        // Hotbar del Jugador (Slot 0: Pico, Slots 1..6: Bloques equipados, Slot 7: Pincel Activo)
        this.activeSlot = 0;
        this.hotbar = [
            { type: 'tool', id: 'pickaxe', name: 'Pico de Diamante', icon: '⛏️', count: Infinity },
            { type: 'block', id: 'grass', count: 64 },
            { type: 'block', id: 'stone', count: 64 },
            { type: 'block', id: 'wood', count: 64 },
            { type: 'block', id: 'leaves', count: 64 },
            { type: 'block', id: 'dirt', count: 64 },
            { type: 'block', id: 'water', count: 64 },
            { type: 'brush', id: 'active_brush', name: 'Cubo Pincel (Color/Shader)', count: Infinity }
        ];

        this.onInventoryChange = null;
        this.onPickupToast = null;

        this.buildCharacterModel();
        this.buildFirstPersonRig();
        this.buildTargetHighlightBox();
    }

    /**
     * Construye el Personaje Voxel 3D completo (Cabeza, Torso, Brazos, Piernas y Pico Voxel 3D en mano)
     */
    buildCharacterModel() {
        this.characterGroup = new THREE.Group();

        const skinMat = new THREE.MeshLambertMaterial({ color: 0xf4b998 });
        const hairMat = new THREE.MeshLambertMaterial({ color: 0x3b2314 });
        const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const eyePupilMat = new THREE.MeshBasicMaterial({ color: 0x2563eb });
        const shirtMat = new THREE.MeshLambertMaterial({ color: 0x0ea5e9 });
        const pantsMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
        const shoesMat = new THREE.MeshLambertMaterial({ color: 0x334155 });

        this.headPivot = new THREE.Group();
        this.headPivot.position.set(0, 1.32, 0);

        const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.44), skinMat);
        headMesh.position.y = 0.22;
        headMesh.castShadow = true;
        this.headPivot.add(headMesh);

        const hairTop = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.46), hairMat);
        hairTop.position.set(0, 0.41, 0);
        this.headPivot.add(hairTop);

        const hairBack = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.34, 0.1), hairMat);
        hairBack.position.set(0, 0.24, 0.2);
        this.headPivot.add(hairBack);

        const leftEyeW = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.02), eyeWhiteMat);
        leftEyeW.position.set(-0.1, 0.22, -0.225);
        const leftEyeP = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.025), eyePupilMat);
        leftEyeP.position.set(-0.08, 0.22, -0.228);

        const rightEyeW = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.02), eyeWhiteMat);
        rightEyeW.position.set(0.1, 0.22, -0.225);
        const rightEyeP = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.025), eyePupilMat);
        rightEyeP.position.set(0.08, 0.22, -0.228);

        this.headPivot.add(leftEyeW, leftEyeP, rightEyeW, rightEyeP);
        this.characterGroup.add(this.headPivot);

        const torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.66, 0.24), shirtMat);
        torsoMesh.position.set(0, 0.99, 0);
        torsoMesh.castShadow = true;
        this.characterGroup.add(torsoMesh);

        this.leftArmPivot = new THREE.Group();
        this.leftArmPivot.position.set(-0.34, 1.28, 0);
        const leftShoulder = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), shirtMat);
        leftShoulder.position.y = -0.1;
        const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.42, 0.18), skinMat);
        leftArm.position.y = -0.36;
        leftArm.castShadow = true;
        this.leftArmPivot.add(leftShoulder, leftArm);
        this.characterGroup.add(this.leftArmPivot);

        this.rightArmPivot = new THREE.Group();
        this.rightArmPivot.position.set(0.34, 1.28, 0);
        const rightShoulder = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), shirtMat);
        rightShoulder.position.y = -0.1;
        const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.42, 0.18), skinMat);
        rightArm.position.y = -0.36;
        rightArm.castShadow = true;
        this.rightArmPivot.add(rightShoulder, rightArm);

        this.worldPickaxe = this.createVoxelPickaxeMesh(0.75);
        this.worldPickaxe.position.set(0, -0.52, -0.16);
        this.worldPickaxe.rotation.x = Math.PI * 0.15;
        this.rightArmPivot.add(this.worldPickaxe);

        this.worldHeldCube = new THREE.Mesh(
            new THREE.BoxGeometry(0.28, 0.28, 0.28),
            this.materialManager.getMaterial('grass')
        );
        this.worldHeldCube.position.set(0, -0.52, -0.18);
        this.worldHeldCube.visible = false;
        this.rightArmPivot.add(this.worldHeldCube);

        this.characterGroup.add(this.rightArmPivot);

        this.leftLegPivot = new THREE.Group();
        this.leftLegPivot.position.set(-0.12, 0.66, 0);
        const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.56, 0.21), pantsMat);
        leftLeg.position.y = -0.28;
        leftLeg.castShadow = true;
        const leftShoe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.24), shoesMat);
        leftShoe.position.set(0, -0.60, -0.02);
        this.leftLegPivot.add(leftLeg, leftShoe);
        this.characterGroup.add(this.leftLegPivot);

        this.rightLegPivot = new THREE.Group();
        this.rightLegPivot.position.set(0.12, 0.66, 0);
        const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.56, 0.21), pantsMat);
        rightLeg.position.y = -0.28;
        rightLeg.castShadow = true;
        const rightShoe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.24), shoesMat);
        rightShoe.position.set(0, -0.60, -0.02);
        this.rightLegPivot.add(rightLeg, rightShoe);
        this.characterGroup.add(this.rightLegPivot);

        this.scene.add(this.characterGroup);
    }

    createVoxelPickaxeMesh(scale = 1.0) {
        const group = new THREE.Group();
        const woodMat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
        const darkWoodMat = new THREE.MeshLambertMaterial({ color: 0x5c3a1b });
        const diamondMat = new THREE.MeshStandardMaterial({
            color: 0x38bdf8,
            emissive: 0x0284c7,
            emissiveIntensity: 0.35,
            roughness: 0.2,
            metalness: 0.5
        });
        const edgeMat = new THREE.MeshStandardMaterial({
            color: 0xe0f2fe,
            emissive: 0x38bdf8,
            emissiveIntensity: 0.4,
            roughness: 0.1
        });

        const handle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.62, 0.07), woodMat);
        handle.position.set(0, 0, -0.18);
        handle.rotation.x = -Math.PI * 0.35;
        group.add(handle);

        const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.08), darkWoodMat);
        grip.position.set(0, -0.14, -0.02);
        grip.rotation.x = -Math.PI * 0.35;
        group.add(grip);

        const headCenter = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.12, 0.38), diamondMat);
        headCenter.position.set(0, 0.18, -0.38);
        headCenter.rotation.x = -Math.PI * 0.35;
        group.add(headCenter);

        const tipFront = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.09), edgeMat);
        tipFront.position.set(0, 0.06, -0.50);
        tipFront.rotation.x = -Math.PI * 0.15;
        group.add(tipFront);

        const tipBack = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 0.09), edgeMat);
        tipBack.position.set(0, 0.30, -0.26);
        tipBack.rotation.x = -Math.PI * 0.55;
        group.add(tipBack);

        group.scale.setScalar(scale);
        return group;
    }

    buildFirstPersonRig() {
        this.fpRig = new THREE.Group();
        this.fpPickaxe = this.createVoxelPickaxeMesh(0.95);
        this.fpPickaxe.position.set(0.48, -0.38, -0.68);
        this.fpPickaxe.rotation.set(0.25, -0.35, -0.15);
        this.fpRig.add(this.fpPickaxe);

        this.fpHeldCube = new THREE.Mesh(
            new THREE.BoxGeometry(0.32, 0.32, 0.32),
            this.materialManager.getMaterial('grass')
        );
        this.fpHeldCube.position.set(0.52, -0.38, -0.72);
        this.fpHeldCube.rotation.set(0.2, 0.65, 0);
        this.fpHeldCube.visible = false;
        this.fpRig.add(this.fpHeldCube);

        this.camera.add(this.fpRig);
    }

    buildTargetHighlightBox() {
        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.012, 1.012, 1.012));
        const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
        this.highlightBox = new THREE.LineSegments(edges, lineMat);
        this.highlightBox.visible = false;
        this.scene.add(this.highlightBox);

        const crackGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
        const crackMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            wireframe: true,
            transparent: true,
            opacity: 0.0
        });
        this.miningOverlayMesh = new THREE.Mesh(crackGeo, crackMat);
        this.miningOverlayMesh.visible = false;
        this.scene.add(this.miningOverlayMesh);
    }

    spawnAtCenter() {
        const y = this.world.getHighestY(0, 0);
        this.position.set(0, y + 0.05, 0);
        this.velocity.set(0, 0, 0);
        this.updateCharacterVisuals(0);
    }

    selectHotbarSlot(index) {
        if (index < 0 || index >= this.hotbar.length) return;
        this.activeSlot = index;
        this.refreshHeldItemVisuals();
        if (this.onInventoryChange) this.onInventoryChange();
    }

    getActiveHotbarItem() {
        return this.hotbar[this.activeSlot] || this.hotbar[0];
    }

    getInventoryCount(blockId) {
        if (!this.inventoryCounts.has(blockId)) {
            this.inventoryCounts.set(blockId, 64);
        }
        return this.inventoryCounts.get(blockId);
    }

    /**
     * Equipa un bloque (del bioma, color o shader 1-buffer) en un slot de la Hotbar (1..6) desde el Inventario
     */
    equipBlockInHotbar(blockId, targetSlotIndex = null) {
        if (!blockId) return;
        if (!this.inventoryCounts.has(blockId) || this.inventoryCounts.get(blockId) <= 0) {
            this.inventoryCounts.set(blockId, 64);
        }
        const count = this.inventoryCounts.get(blockId);

        // Si ya está en la hotbar, seleccionarlo o moverlo al slot pedido
        const existingIdx = this.hotbar.findIndex(s => s.type === 'block' && s.id === blockId);
        if (existingIdx !== -1 && targetSlotIndex === null) {
            this.hotbar[existingIdx].count = count;
            this.selectHotbarSlot(existingIdx);
            return existingIdx;
        }

        let slotIdx = targetSlotIndex;
        if (slotIdx === null || slotIdx < 1 || slotIdx > 6) {
            if (this.activeSlot >= 1 && this.activeSlot <= 6) {
                slotIdx = this.activeSlot;
            } else {
                slotIdx = 1;
            }
        }

        this.hotbar[slotIdx] = {
            type: 'block',
            id: blockId,
            count
        };
        this.selectHotbarSlot(slotIdx);
        return slotIdx;
    }

    /**
     * Determina qué blockId se coloca al hacer click derecho (o click con bloque seleccionado)
     */
    getBlockIdToPlace() {
        const item = this.getActiveHotbarItem();
        if (item.type === 'block') {
            return item.id;
        }
        const brushDef = this.materialManager.getOrCreateBrushBlock();
        return brushDef.id;
    }

    refreshHeldItemVisuals() {
        const item = this.getActiveHotbarItem();
        const isPickaxe = item.type === 'tool';

        if (this.worldPickaxe) this.worldPickaxe.visible = isPickaxe;
        if (this.fpPickaxe) this.fpPickaxe.visible = isPickaxe;
        if (this.worldHeldCube) this.worldHeldCube.visible = !isPickaxe;
        if (this.fpHeldCube) this.fpHeldCube.visible = !isPickaxe;

        if (!isPickaxe) {
            const blockId = item.type === 'brush'
                ? this.materialManager.getOrCreateBrushBlock().id
                : item.id;
            const mat = this.materialManager.getMaterial(blockId);
            if (this.worldHeldCube) this.worldHeldCube.material = mat;
            if (this.fpHeldCube) this.fpHeldCube.material = mat;
        }
    }

    /**
     * Llamado cuando el personaje agarra un cubito del piso (Drop)
     */
    collectBlockDrop(blockId) {
        const prevCount = this.inventoryCounts.get(blockId) || 0;
        const nextCount = prevCount + 1;
        this.inventoryCounts.set(blockId, nextCount);

        let slot = this.hotbar.find(s => s.type === 'block' && s.id === blockId);
        if (slot) {
            if (isFinite(slot.count)) slot.count += 1;
        } else {
            const emptySlot = this.hotbar.find(s => s.type === 'block' && s.count <= 0);
            if (emptySlot) {
                emptySlot.id = blockId;
                emptySlot.count = nextCount;
            }
        }
        if (this.onInventoryChange) this.onInventoryChange();
        if (this.onPickupToast) {
            const def = this.materialManager.getBlockDef(blockId);
            this.onPickupToast(def ? def.name : blockId);
        }
    }

    triggerSwing() {
        this.isSwinging = true;
        this.swingPhase = 0;
    }

    placeBlockAtTarget() {
        if (!this.targetedHit || !this.targetedHit.placePos) return false;
        const { x, y, z } = this.targetedHit.placePos;

        if (this.intersectsPlayerBody(x, y, z)) return false;

        const item = this.getActiveHotbarItem();
        let blockId;
        if (item.type === 'block') {
            if (item.count <= 0) return false;
            blockId = item.id;
            if (isFinite(item.count)) {
                item.count--;
                this.inventoryCounts.set(blockId, Math.max(0, item.count));
            }
        } else {
            blockId = this.materialManager.getOrCreateBrushBlock().id;
        }

        const ok = this.world.placeBlock(x, y, z, blockId);
        if (ok) {
            this.triggerSwing();
            if (this.onInventoryChange) this.onInventoryChange();
        }
        return ok;
    }

    intersectsPlayerBody(bx, by, bz) {
        const halfW = this.width * 0.45;
        const minX = this.position.x - halfW, maxX = this.position.x + halfW;
        const minY = this.position.y + 0.05, maxY = this.position.y + this.height - 0.05;
        const minZ = this.position.z - halfW, maxZ = this.position.z + halfW;

        return (
            maxX > bx - 0.5 && minX < bx + 0.5 &&
            maxY > by - 0.5 && minY < by + 0.5 &&
            maxZ > bz - 0.5 && minZ < bz + 0.5
        );
    }

    /**
     * Actualización principal del Jugador en Modo Usuario (Física 3D, Cámara, Raycast de Pico y Recolección)
     */
    update(dt, isUserModeActive) {
        this.world.updateEntities(dt, this.position, (blockId) => this.collectBlockDrop(blockId));

        if (!isUserModeActive) {
            this.highlightBox.visible = false;
            this.miningOverlayMesh.visible = false;
            this.fpRig.visible = false;
            this.characterGroup.visible = true;
            this.updateCharacterVisuals(dt, false);
            return;
        }

        this.fpRig.visible = !this.thirdPerson;
        this.characterGroup.visible = this.thirdPerson;

        const moveForward = (this.keys.forward ? 1 : 0) - (this.keys.backward ? 1 : 0);
        const moveRight = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);

        const forwardDir = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
        const rightDir = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();

        const moveVec = new THREE.Vector3();
        moveVec.addScaledVector(forwardDir, moveForward);
        moveVec.addScaledVector(rightDir, moveRight);
        if (moveVec.lengthSq() > 0) moveVec.normalize();

        const baseSpeed = this.isFlying ? 12.0 : 5.8;
        const speed = this.keys.sprint ? baseSpeed * 1.55 : baseSpeed;

        this.velocity.x = moveVec.x * speed;
        this.velocity.z = moveVec.z * speed;

        if (this.isFlying) {
            let vy = 0;
            if (this.keys.jump || this.keys.up) vy += 8.0;
            if (this.keys.descend || this.keys.down) vy -= 8.0;
            this.velocity.y = vy;
            this.moveWithCollisions(dt);
        } else {
            this.velocity.y -= 24.0 * dt;
            if (this.velocity.y < -32) this.velocity.y = -32;

            if (this.keys.jump && this.onGround) {
                this.velocity.y = 8.4;
                this.onGround = false;
            }
            this.moveWithCollisions(dt);
        }

        if (this.position.y < -22) {
            this.spawnAtCenter();
        }

        const eyePos = new THREE.Vector3(
            this.position.x,
            this.position.y + this.eyeHeight,
            this.position.z
        );

        const lookQuat = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')
        );
        const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(lookQuat).normalize();

        if (this.thirdPerson) {
            const camOffset = lookDir.clone().multiplyScalar(-this.thirdPersonDist);
            camOffset.y += 0.45;
            this.camera.position.copy(eyePos).add(camOffset);
            this.camera.quaternion.copy(lookQuat);
        } else {
            this.camera.position.copy(eyePos);
            this.camera.quaternion.copy(lookQuat);
        }

        this.targetedHit = this.world.raycast(eyePos, lookDir, 6.8, null);

        if (this.targetedHit && !this.targetedHit.isPlane) {
            const { x, y, z } = this.targetedHit.voxel;
            this.highlightBox.position.set(x, y, z);
            this.highlightBox.visible = true;
        } else {
            this.highlightBox.visible = false;
        }

        if (this.isMining && this.targetedHit && !this.targetedHit.isPlane) {
            const { x, y, z } = this.targetedHit.voxel;
            const targetKey = this.world.key(x, y, z);
            if (this.miningTargetKey !== targetKey) {
                this.miningTargetKey = targetKey;
                this.miningProgress = 0;
            }

            const prevStage = Math.floor(this.miningProgress * 4);
            this.miningProgress += dt / this.miningDuration;
            const curStage = Math.floor(this.miningProgress * 4);

            if (!this.isSwinging) this.triggerSwing();

            if (curStage > prevStage && this.miningProgress < 1.0) {
                const def = this.materialManager.getBlockDef(this.targetedHit.blockId);
                if (window.voxelAudio) window.voxelAudio.playMineHit(def ? def.category : 'stone');
                this.world.spawnBreakParticles(x, y, z, this.targetedHit.blockId, 3);
            }

            this.miningOverlayMesh.position.set(x, y, z);
            this.miningOverlayMesh.visible = true;
            this.miningOverlayMesh.material.opacity = 0.25 + this.miningProgress * 0.55;
            const s = 1.02 - this.miningProgress * 0.12;
            this.miningOverlayMesh.scale.setScalar(s);

            if (this.miningProgress >= 1.0) {
                this.world.mineBlock(x, y, z, true);
                this.miningProgress = 0;
                this.miningTargetKey = null;
                this.miningOverlayMesh.visible = false;
            }
        } else {
            this.miningProgress = 0;
            this.miningTargetKey = null;
            this.miningOverlayMesh.visible = false;
        }

        const isMovingHoriz = moveVec.lengthSq() > 0.01;
        this.updateCharacterVisuals(dt, isMovingHoriz);
    }

    moveWithCollisions(dt) {
        this.position.x += this.velocity.x * dt;
        if (this.checkWorldCollision(this.position.x, this.position.y, this.position.z)) {
            this.position.x -= this.velocity.x * dt;
            this.velocity.x = 0;
        }

        this.position.z += this.velocity.z * dt;
        if (this.checkWorldCollision(this.position.x, this.position.y, this.position.z)) {
            this.position.z -= this.velocity.z * dt;
            this.velocity.z = 0;
        }

        const dy = this.velocity.y * dt;
        this.position.y += dy;
        this.onGround = false;
        if (this.checkWorldCollision(this.position.x, this.position.y, this.position.z)) {
            if (dy < 0) {
                this.onGround = true;
                this.position.y = Math.floor(this.position.y + 0.5) - 0.5 + 1.0001;
            } else {
                this.position.y -= dy;
            }
            this.velocity.y = 0;
        }
    }

    checkWorldCollision(px, py, pz) {
        const halfW = this.width / 2;
        const minX = Math.floor(px - halfW + 0.5);
        const maxX = Math.floor(px + halfW + 0.5 - 0.001);
        const minY = Math.floor(py + 0.5);
        const maxY = Math.floor(py + this.height + 0.5 - 0.001);
        const minZ = Math.floor(pz - halfW + 0.5);
        const maxZ = Math.floor(pz + halfW + 0.5 - 0.001);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                for (let z = minZ; z <= maxZ; z++) {
                    const b = this.world.getBlock(x, y, z);
                    if (b && b !== 'water') {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    updateCharacterVisuals(dt, isWalking = false) {
        this.characterGroup.position.copy(this.position);
        this.characterGroup.rotation.y = this.yaw;

        if (this.headPivot) {
            this.headPivot.rotation.x = Math.max(-0.6, Math.min(0.6, this.pitch));
        }

        if (isWalking) {
            const freq = this.keys.sprint ? 13 : 9;
            this.walkCycle += dt * freq;
            this.stepAccumulator += dt * freq;
            if (this.stepAccumulator >= Math.PI && this.onGround) {
                this.stepAccumulator = 0;
                if (window.voxelAudio) window.voxelAudio.playStep();
            }
        } else {
            this.walkCycle *= 0.85;
        }

        const legAngle = isWalking ? Math.sin(this.walkCycle) * 0.65 : 0;
        if (this.leftLegPivot) this.leftLegPivot.rotation.x = legAngle;
        if (this.rightLegPivot) this.rightLegPivot.rotation.x = -legAngle;
        if (this.leftArmPivot) this.leftArmPivot.rotation.x = -legAngle * 0.8;

        let swingOffset = 0;
        if (this.isSwinging) {
            this.swingPhase += dt * 16.0;
            if (this.swingPhase >= Math.PI) {
                this.swingPhase = 0;
                if (!this.isMining) this.isSwinging = false;
            }
            swingOffset = Math.sin(this.swingPhase) * 1.15;
        }

        if (this.rightArmPivot) {
            this.rightArmPivot.rotation.x = 0.45 + swingOffset + (isWalking && !this.isSwinging ? legAngle * 0.5 : 0);
        }

        if (this.fpRig) {
            const bobX = isWalking ? Math.cos(this.walkCycle * 0.5) * 0.025 : 0;
            const bobY = isWalking ? Math.abs(Math.sin(this.walkCycle)) * 0.03 : 0;
            this.fpRig.position.set(bobX, -bobY, 0);
            this.fpPickaxe.rotation.x = 0.25 - swingOffset * 0.85;
            this.fpPickaxe.rotation.z = -0.15 - swingOffset * 0.35;
            this.fpHeldCube.rotation.x = 0.2 - swingOffset * 0.6;
        }
    }
}

window.PlayerController = PlayerController;
