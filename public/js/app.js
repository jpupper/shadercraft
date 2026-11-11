/**
 * VoxelCraftShaderApp — Coordinador Principal de ShaderCraft 3D (Minecraft Multijugador + Shaders 1-Buffer)
 * ---------------------------------------------------------------------------------------------------------
 * Integra:
 *  1) Escena 3D Three.js de gran alcance con iluminación solar, sombras suaves y Cielo Dinámico / Shader Skybox
 *  2) Modo Usuario (Juego 3D con Personaje, Pico 3D, Picar y Agarrar Cubos, 1ª y 3ª Persona, Vuelo 3D)
 *  3) Modo Dios (Vista desde arriba con subida/bajada en altura mediante E y Q, Poner/Pintar/Borrar cubos)
 *  4) Inventario Completo estilo Minecraft (Bloques del Bioma, Cubos con Shaders 1-Buffer y Cubos de Color)
 *  5) Catálogo filtrado exclusivamente a Shaders de 1 Solo Buffer de jpshadereditorInclude (0 líneas/grillas)
 *  6) Creador de Biomas Amplios (48x48, 64x64, 80x80, 96x96)
 *  7) Sincronización Multijugador en Tiempo Real con Node.js + Socket.IO
 */
class VoxelCraftShaderApp {
    constructor() {
        this.canvasContainer = document.getElementById('viewport-container');
        this.mode = 'user'; // 'user' (Modo Juego 3D) | 'god' (Modo Dios desde arriba)

        // Destino actual cuando se selecciona un color o shader en el panel derecho:
        this.assignTarget = 'brush';

        // Estado del catálogo de shaders 1-buffer en UI ('shaders' | 'builtins')
        this.shaderTab = 'shaders';
        this.shaderSearchQuery = '';

        // Pestaña activa del Inventario ('all' | 'biome' | 'shaders' | 'colors')
        this.inventoryTab = 'all';

        this.initThreeScene();

        this.materialManager = new MaterialManager(window.jpShaderHub);
        this.world = new VoxelWorld(this.scene, this.materialManager);
        this.player = new PlayerController(this.scene, this.camera, this.renderer.domElement, this.world, this.materialManager);
        this.godMode = new GodModeController(this.scene, this.camera, this.renderer.domElement, this.world, this.materialManager, this.player);
        this.multiplayer = new MultiplayerManager(this.scene, this.world, this.materialManager, this.player);

        // Generar bioma amplio inicial (64x64) y posicionar personaje con el pico
        this.world.generateBiome();
        this.player.spawnAtCenter();

        this.bindEvents();
        this.initUI();
        this.initMultiplayerHooks();

        this.lastTime = performance.now();
        this.frames = 0;
        this.lastFpsUpdate = performance.now();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    initThreeScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x7dd3fc);
        this.scene.fog = new THREE.FogExp2(0x7dd3fc, 0.0065);

        this.camera = new THREE.PerspectiveCamera(
            70,
            window.innerWidth / window.innerHeight,
            0.1,
            420
        );
        this.scene.add(this.camera);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.canvasContainer.appendChild(this.renderer.domElement);

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.60);
        this.scene.add(this.ambientLight);

        this.hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x334155, 0.45);
        this.hemiLight.position.set(0, 70, 0);
        this.scene.add(this.hemiLight);

        this.sunLight = new THREE.DirectionalLight(0xfffbeb, 1.15);
        this.sunLight.position.set(42, 68, 36);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 1;
        this.sunLight.shadow.camera.far = 220;
        const d = 58;
        this.sunLight.shadow.camera.left = -d;
        this.sunLight.shadow.camera.right = d;
        this.sunLight.shadow.camera.top = d;
        this.sunLight.shadow.camera.bottom = -d;
        this.sunLight.shadow.bias = -0.0008;
        this.scene.add(this.sunLight);

        const skyGeo = new THREE.SphereGeometry(240, 32, 24);
        this.skySphereMat = new THREE.MeshBasicMaterial({
            side: THREE.BackSide,
            depthWrite: false
        });
        this.skySphere = new THREE.Mesh(skyGeo, this.skySphereMat);
        this.skySphere.visible = false;
        this.scene.add(this.skySphere);
    }

    initMultiplayerHooks() {
        this.world.onBlockMined = (x, y, z) => {
            this.multiplayer.emitBlockMine(x, y, z);
        };

        this.world.onBlockPlaced = (x, y, z, blockId, blockDef) => {
            this.multiplayer.emitBlockPlace(x, y, z, blockId, blockDef);
        };

        this.godMode.onGodBatchChanges = (changes, blockDef) => {
            this.multiplayer.emitBlocksBatch(changes, blockDef);
        };

        this.multiplayer.onToast = (msg) => this.showToast(msg);

        this.multiplayer.onStatusChange = (st) => {
            const dot = document.getElementById('mp-status-dot');
            const lbl = document.getElementById('mp-online-label');
            const inp = document.getElementById('input-mp-nickname');
            if (dot) dot.classList.toggle('online', !!st.connected);
            if (lbl) lbl.textContent = st.connected ? `${st.onlineCount} Online` : 'Local';
            if (inp && document.activeElement !== inp) {
                inp.value = st.playerName || '';
            }
        };

        this.multiplayer.onRemoteBiomeSynced = () => {
            this.updateSkyAppearance();
            this.syncBiomeCreatorInputsWithWorld();
            this.renderBiomeBlocksConfigUI();
            this.renderHotbarUI();
        };

        this.multiplayer.onRemoteMaterialSynced = () => {
            this.updateSkyAppearance();
            this.renderBiomeBlocksConfigUI();
            this.renderHotbarUI();
            this.updateActiveTargetSummary();
        };

        this.multiplayer.connect();
    }

    updateSkyAppearance() {
        const sky = this.materialManager.skyConfig;
        if (sky.mode === 'shader') {
            const entry = window.jpShaderHub.getOrCreateShaderEntry(sky.shaderKind || 'shader', sky.shaderValue);
            this.skySphereMat.map = entry.texture;
            this.skySphereMat.needsUpdate = true;
            this.skySphere.visible = true;
            this.scene.fog.density = 0.0025;
            this.scene.fog.color.setHex(0x0f172a);
        } else {
            this.skySphere.visible = false;
            let hex = '#7dd3fc';
            if (sky.mode === 'color') {
                hex = sky.color;
            } else {
                if (sky.preset === 'day') hex = '#7dd3fc';
                else if (sky.preset === 'sunset') hex = '#fb923c';
                else if (sky.preset === 'night') hex = '#090d16';
                else if (sky.preset === 'cyber') hex = '#1e1b4b';
            }
            this.scene.background = new THREE.Color(hex);
            this.scene.fog.color.set(hex);
            this.scene.fog.density = 0.0065;
        }
    }

    setMode(newMode) {
        if (this.mode === newMode) return;
        this.mode = newMode;

        if (this.mode === 'god') {
            if (document.pointerLockElement) {
                document.exitPointerLock();
            }
            this.player.isMining = false;
            this.godMode.enterGodMode();
            document.getElementById('studio-sidebar').classList.remove('collapsed');
        } else {
            this.godMode.exitGodMode();
        }

        this.updateModeUI();
    }

    toggleMode() {
        this.setMode(this.mode === 'user' ? 'god' : 'user');
    }

    bindEvents() {
        const dom = this.renderer.domElement;

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });

        document.addEventListener('pointerlockchange', () => {
            this.player.isPointerLocked = (document.pointerLockElement === dom);
            const lockHint = document.getElementById('pointerlock-hint');
            if (lockHint) {
                lockHint.style.display = (this.mode === 'user' && !this.player.isPointerLocked) ? 'flex' : 'none';
            }
        });

        // Teclado global
        window.addEventListener('keydown', (e) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
                if (e.key === 'Escape') document.activeElement.blur();
                return;
            }

            const code = e.code;
            if (code === 'Escape') {
                this.toggleInventoryModal(false);
                this.toggleBiomeModal(false);
                return;
            }

            if (code === 'KeyW' || code === 'ArrowUp') this.player.keys.forward = true;
            if (code === 'KeyS' || code === 'ArrowDown') this.player.keys.backward = true;
            if (code === 'KeyA' || code === 'ArrowLeft') this.player.keys.left = true;
            if (code === 'KeyD' || code === 'ArrowRight') this.player.keys.right = true;

            // REQUERIMIENTO #1: En Modo Dios (y en vuelo) Q baja y E sube en altura
            if (code === 'KeyQ') {
                this.player.keys.down = true;
            }
            if (code === 'KeyE') {
                if (this.mode === 'god' || this.player.isFlying) {
                    this.player.keys.up = true;
                } else {
                    this.toggleInventoryModal();
                }
            }

            if (code === 'Space') {
                e.preventDefault();
                this.player.keys.jump = true;
            }
            if (code === 'ShiftLeft' || code === 'ShiftRight') {
                this.player.keys.sprint = true;
                this.player.keys.descend = true;
            }

            // Alternar Modo Juego <-> Modo Dios con Tab o G
            if (code === 'Tab' || code === 'KeyG') {
                e.preventDefault();
                this.toggleMode();
            }

            // Abrir/Cerrar Inventario con I
            if (code === 'KeyI') {
                this.toggleInventoryModal();
            }

            // Alternar 1ª / 3ª Persona en Modo Usuario con V
            if (code === 'KeyV' && this.mode === 'user') {
                this.player.thirdPerson = !this.player.thirdPerson;
                this.updateModeUI();
            }

            // Alternar Caminar / Vuelo Libre 3D con F
            if (code === 'KeyF' && this.mode === 'user') {
                this.player.isFlying = !this.player.isFlying;
                this.player.velocity.y = 0;
                this.updateModeUI();
            }

            // Abrir/Cerrar Creador de Bioma con B
            if (code === 'KeyB') {
                this.toggleBiomeModal();
            }

            // Abrir/Cerrar Panel de Color y Shaders con C
            if (code === 'KeyC') {
                document.getElementById('studio-sidebar').classList.toggle('collapsed');
            }

            // Selección de Hotbar 1..8
            if (/^Digit[1-8]$/.test(code)) {
                const idx = parseInt(code.replace('Digit', ''), 10) - 1;
                this.player.selectHotbarSlot(idx);
                if (this.mode === 'god') {
                    const item = this.player.getActiveHotbarItem();
                    this.godMode.sourceMode = (item && item.type === 'block') ? 'hotbar' : 'brush';
                }
            }
        });

        window.addEventListener('keyup', (e) => {
            const code = e.code;
            if (code === 'KeyW' || code === 'ArrowUp') this.player.keys.forward = false;
            if (code === 'KeyS' || code === 'ArrowDown') this.player.keys.backward = false;
            if (code === 'KeyA' || code === 'ArrowLeft') this.player.keys.left = false;
            if (code === 'KeyD' || code === 'ArrowRight') this.player.keys.right = false;
            if (code === 'KeyQ') this.player.keys.down = false;
            if (code === 'KeyE') this.player.keys.up = false;
            if (code === 'Space') this.player.keys.jump = false;
            if (code === 'ShiftLeft' || code === 'ShiftRight') {
                this.player.keys.sprint = false;
                this.player.keys.descend = false;
            }
        });

        dom.addEventListener('contextmenu', (e) => e.preventDefault());

        dom.addEventListener('mousedown', (e) => {
            if (window.voxelAudio) window.voxelAudio.init();

            if (this.mode === 'user') {
                if (e.button === 0) {
                    this.player.isDraggingLook = true;
                    this.player.dragMoved = false;
                    this.player.lastMouse = { x: e.clientX, y: e.clientY };
                    this.player.isMining = true;
                    this.player.triggerSwing();
                } else if (e.button === 2) {
                    this.player.placeBlockAtTarget();
                }
            } else {
                const rect = dom.getBoundingClientRect();
                this.godMode.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                this.godMode.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
                this.godMode.lastMouse = { x: e.clientX, y: e.clientY };

                if (e.button === 0 && !e.altKey && !e.shiftKey) {
                    this.godMode.isPaintingStroke = true;
                    this.godMode.strokeLockedY = null;
                    this.godMode.lastStrokeVoxelKey = null;
                    this.godMode.executeGodAction();
                } else if (e.button === 0 && e.altKey) {
                    const prevTool = this.godMode.tool;
                    this.godMode.tool = 'pick';
                    this.godMode.executeGodAction();
                    this.godMode.tool = prevTool;
                } else if (e.button === 2 && !e.shiftKey) {
                    this.godMode.isOrbiting = true;
                    this.godMode.rightClickMoved = false;
                } else if (e.button === 1 || (e.button === 2 && e.shiftKey) || (e.button === 0 && e.shiftKey)) {
                    this.godMode.isPanning = true;
                }
            }
        });

        window.addEventListener('mousemove', (e) => {
            const rect = dom.getBoundingClientRect();
            this.godMode.mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this.godMode.mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

            if (this.mode === 'user') {
                if (this.player.isPointerLocked) {
                    const sens = 0.0024;
                    this.player.yaw -= e.movementX * sens;
                    this.player.pitch = Math.max(-1.48, Math.min(1.48, this.player.pitch - e.movementY * sens));
                } else if (this.player.isDraggingLook) {
                    const dx = e.clientX - this.player.lastMouse.x;
                    const dy = e.clientY - this.player.lastMouse.y;
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                        this.player.dragMoved = true;
                    }
                    this.player.lastMouse = { x: e.clientX, y: e.clientY };
                    const sens = 0.0055;
                    this.player.yaw -= dx * sens;
                    this.player.pitch = Math.max(-1.48, Math.min(1.48, this.player.pitch - dy * sens));
                }
            } else {
                const dx = e.clientX - this.godMode.lastMouse.x;
                const dy = e.clientY - this.godMode.lastMouse.y;
                this.godMode.lastMouse = { x: e.clientX, y: e.clientY };

                if (this.godMode.isOrbiting) {
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.godMode.rightClickMoved = true;
                    this.godMode.theta -= dx * 0.007;
                    this.godMode.phi = Math.max(0.05, Math.min(1.42, this.godMode.phi - dy * 0.007));
                } else if (this.godMode.isPanning) {
                    const panFactor = this.godMode.radius * 0.0018;
                    const forward = new THREE.Vector3(-Math.sin(this.godMode.theta), 0, -Math.cos(this.godMode.theta));
                    const right = new THREE.Vector3(Math.cos(this.godMode.theta), 0, -Math.sin(this.godMode.theta));
                    this.godMode.target.addScaledVector(right, -dx * panFactor);
                    this.godMode.target.addScaledVector(forward, dy * panFactor);
                } else if (this.godMode.isPaintingStroke) {
                    this.godMode.executeGodAction();
                }
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (this.mode === 'user') {
                this.player.isDraggingLook = false;
                this.player.isMining = false;
            } else {
                if (e.button === 2 && this.godMode.isOrbiting && !this.godMode.rightClickMoved) {
                    const prevTool = this.godMode.tool;
                    this.godMode.tool = 'erase';
                    this.godMode.executeGodAction();
                    this.godMode.tool = prevTool;
                }
                this.godMode.isOrbiting = false;
                this.godMode.isPanning = false;
                this.godMode.isPaintingStroke = false;
                this.godMode.strokeLockedY = null;
                this.godMode.lastStrokeVoxelKey = null;
            }
        });

        dom.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.mode === 'god') {
                this.godMode.radius = Math.max(6, Math.min(160, this.godMode.radius + (e.deltaY > 0 ? 3.5 : -3.5)));
            } else {
                const dir = e.deltaY > 0 ? 1 : -1;
                const next = (this.player.activeSlot + dir + this.player.hotbar.length) % this.player.hotbar.length;
                this.player.selectHotbarSlot(next);
            }
        }, { passive: false });
    }

    initUI() {
        const lockBtn = document.getElementById('btn-lock-mouse');
        if (lockBtn) {
            lockBtn.addEventListener('click', () => {
                this.renderer.domElement.requestPointerLock?.();
            });
        }

        // Input de Nickname Multijugador
        const nickInput = document.getElementById('input-mp-nickname');
        if (nickInput) {
            nickInput.value = this.multiplayer.playerName;
            nickInput.addEventListener('change', () => {
                this.multiplayer.setPlayerName(nickInput.value);
                this.showToast(`👤 Nombre actualizado: ${this.multiplayer.playerName}`);
            });
        }

        document.getElementById('btn-mode-user').addEventListener('click', () => this.setMode('user'));
        document.getElementById('btn-mode-god').addEventListener('click', () => this.setMode('god'));

        document.getElementById('btn-toggle-cam').addEventListener('click', () => {
            this.player.thirdPerson = !this.player.thirdPerson;
            this.updateModeUI();
        });
        document.getElementById('btn-toggle-fly').addEventListener('click', () => {
            this.player.isFlying = !this.player.isFlying;
            this.player.velocity.y = 0;
            this.updateModeUI();
        });

        // Inventario
        document.getElementById('btn-open-inventory').addEventListener('click', () => this.toggleInventoryModal(true));
        document.getElementById('btn-close-inventory').addEventListener('click', () => this.toggleInventoryModal(false));

        // Creador de Bioma
        document.getElementById('btn-open-biome').addEventListener('click', () => this.toggleBiomeModal(true));
        document.getElementById('btn-close-biome').addEventListener('click', () => this.toggleBiomeModal(false));

        // Sidebar Color & Shaders 1-Buffer
        document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
            document.getElementById('studio-sidebar').classList.toggle('collapsed');
        });
        document.getElementById('btn-close-sidebar').addEventListener('click', () => {
            document.getElementById('studio-sidebar').classList.add('collapsed');
        });

        const btnAudio = document.getElementById('btn-toggle-audio');
        btnAudio.addEventListener('click', () => {
            const muted = window.voxelAudio.toggleMute();
            btnAudio.textContent = muted ? '🔇' : '🔊';
            btnAudio.title = muted ? 'Activar Sonido' : 'Silenciar Sonido';
        });

        document.getElementById('btn-export-world').addEventListener('click', () => this.exportWorldJson());
        document.getElementById('btn-import-world').addEventListener('click', () => {
            document.getElementById('input-import-world').click();
        });
        document.getElementById('input-import-world').addEventListener('change', (e) => this.importWorldJson(e));

        this.initGodToolbarUI();
        this.initSidebarStudioUI();
        this.initInventoryModalUI();
        this.initBiomeCreatorUI();

        this.materialManager.onIconsUpdated = () => {
            this.renderHotbarUI();
            this.renderBiomeBlocksConfigUI();
            if (this.isInventoryOpen()) this.renderInventoryModalUI();
        };

        this.player.onInventoryChange = () => {
            this.renderHotbarUI();
            if (this.isInventoryOpen()) this.renderInventoryModalUI();
        };
        this.player.onPickupToast = (blockName) => this.showToast(`+1 Cubo al Inventario: ${blockName}`);

        this.godMode.onBrushPicked = (def) => {
            this.showToast(`💧 Copiado: ${def.name}`);
            this.syncSidebarWithTarget();
            this.renderHotbarUI();
        };
        this.godMode.onCoordsUpdate = (x, y, z, bId) => {
            const el = document.getElementById('hud-coords');
            if (el) el.textContent = `XYZ: ${x}, ${y}, ${z}${bId ? ` · [${bId}]` : ''}`;
        };
        this.godMode.onHeightChange = (targetY, lockedY) => {
            const badge = document.getElementById('god-height-readout');
            if (badge) badge.textContent = `Y: ${Math.round(targetY)}`;
            const numLockY = document.getElementById('num-god-lock-y');
            if (numLockY && this.godMode.lockYEnabled) {
                numLockY.value = lockedY;
            }
        };

        this.renderHotbarUI();
        this.updateModeUI();
        this.syncSidebarWithTarget();
        this.renderBiomeBlocksConfigUI();
    }

    initGodToolbarUI() {
        document.querySelectorAll('[data-god-tool]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.godMode.tool = btn.getAttribute('data-god-tool');
                document.querySelectorAll('[data-god-tool]').forEach(b => b.classList.toggle('active', b === btn));
            });
        });

        // Botones de Bajar (Q) y Subir (E) en la barra de Modo Dios
        const btnDownQ = document.getElementById('btn-god-down-q');
        const btnUpE = document.getElementById('btn-god-up-e');
        if (btnDownQ) {
            btnDownQ.addEventListener('click', () => this.godMode.adjustHeightStep(-3));
        }
        if (btnUpE) {
            btnUpE.addEventListener('click', () => this.godMode.adjustHeightStep(3));
        }

        document.querySelectorAll('[data-god-size]').forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.getAttribute('data-god-size');
                this.godMode.brushSize = val === 'column' ? 'column' : parseInt(val, 10);
                document.querySelectorAll('[data-god-size]').forEach(b => b.classList.toggle('active', b === btn));
            });
        });

        document.querySelectorAll('[data-god-cam]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.godMode.setCameraPreset(btn.getAttribute('data-god-cam'));
            });
        });

        const chkLockY = document.getElementById('chk-god-lock-y');
        const numLockY = document.getElementById('num-god-lock-y');
        if (chkLockY && numLockY) {
            chkLockY.addEventListener('change', () => {
                this.godMode.lockYEnabled = chkLockY.checked;
                this.godMode.lockedYValue = parseInt(numLockY.value, 10) || 4;
            });
            numLockY.addEventListener('input', () => {
                this.godMode.lockedYValue = parseInt(numLockY.value, 10) || 4;
            });
        }
    }

    initSidebarStudioUI() {
        const targetSelect = document.getElementById('select-assign-target');
        targetSelect.addEventListener('change', () => {
            this.assignTarget = targetSelect.value;
            this.syncSidebarWithTarget();
        });

        document.querySelectorAll('[data-studio-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-studio-tab');
                document.querySelectorAll('[data-studio-tab]').forEach(b => b.classList.toggle('active', b === btn));
                document.getElementById('studio-pane-color').style.display = tab === 'color' ? 'block' : 'none';
                document.getElementById('studio-pane-shader').style.display = tab === 'shader' ? 'flex' : 'none';
            });
        });

        const paletteColors = [
            '#56b847', '#368f36', '#865d3b', '#848c94', '#7c5330', '#e3cf8a',
            '#38bdf8', '#2563eb', '#6366f1', '#a855f7', '#ec4899', '#f43f5e',
            '#ef4444', '#f97316', '#eab308', '#84cc16', '#10b981', '#14b8a6',
            '#f8fafc', '#cbd5e1', '#64748b', '#334155', '#1e293b', '#0f172a'
        ];
        const swatchesCont = document.getElementById('color-swatches-grid');
        swatchesCont.innerHTML = paletteColors.map(hex =>
            `<button class="color-swatch" data-hex="${hex}" title="${hex}"></button>`
        ).join('');
        swatchesCont.querySelectorAll('.color-swatch').forEach(btn => {
            btn.style.backgroundColor = btn.getAttribute('data-hex');
        });

        swatchesCont.addEventListener('click', (e) => {
            const sw = e.target.closest('[data-hex]');
            if (!sw) return;
            const hex = sw.getAttribute('data-hex');
            this.applyColorSelection(hex);
        });

        const colorInput = document.getElementById('input-solid-color');
        const hexTextInput = document.getElementById('input-hex-text');

        colorInput.addEventListener('input', () => {
            hexTextInput.value = colorInput.value.toUpperCase();
            this.applyColorSelection(colorInput.value);
        });
        hexTextInput.addEventListener('change', () => {
            let val = hexTextInput.value.trim();
            if (!val.startsWith('#')) val = '#' + val;
            if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                colorInput.value = val;
                this.applyColorSelection(val);
            }
        });

        document.querySelectorAll('[data-voxel-pattern]').forEach(btn => {
            btn.addEventListener('click', () => {
                const pat = btn.getAttribute('data-voxel-pattern');
                document.querySelectorAll('[data-voxel-pattern]').forEach(b => b.classList.toggle('active', b === btn));
                this.applyPatternSelection(pat);
            });
        });

        document.querySelectorAll('[data-jpsi-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.shaderTab = btn.getAttribute('data-jpsi-tab');
                document.querySelectorAll('[data-jpsi-tab]').forEach(b => b.classList.toggle('active', b === btn));
                this.renderShaderCatalogGrid();
            });
        });

        const searchInput = document.getElementById('input-shader-search');
        searchInput.addEventListener('input', () => {
            this.shaderSearchQuery = searchInput.value;
            this.renderShaderCatalogGrid();
        });

        document.getElementById('btn-jpsi-srv-toggle').addEventListener('click', () => {
            const next = window.jpShaderHub.serverStatus.active === 'vps' ? 'local' : 'vps';
            window.jpShaderHub.setServerMode(next);
            this.showToast(`Servidor jpshadereditor cambiado a: ${next.toUpperCase()}`);
        });

        window.jpShaderHub.onCatalogUpdate(() => {
            this.updateShaderHubStatusBadge();
            this.renderShaderCatalogGrid();
            this.renderActiveShaderUniforms();
            if (this.isInventoryOpen()) this.renderInventoryModalUI();
        });

        this.updateShaderHubStatusBadge();
        this.renderShaderCatalogGrid();
    }

    updateShaderHubStatusBadge() {
        const cat = window.jpShaderHub.catalog;
        const st = window.jpShaderHub.serverStatus;
        const badge = document.getElementById('jpsi-connection-pill');
        if (badge) {
            const srvLabel = st.active === 'vps' ? (st.web ? 'VPS ●' : 'VPS ○') : (st.local ? 'LOCAL ●' : 'LOCAL ○');
            badge.innerHTML = `✦ jpshadereditor · <b>${srvLabel}</b> · ${cat.shaders.length} Shaders (1-Buffer)`;
        }

        const cntShaders = document.getElementById('cnt-tab-shaders');
        const cntBuiltins = document.getElementById('cnt-tab-builtins');
        if (cntShaders) cntShaders.textContent = cat.shaders.length || '…';
        if (cntBuiltins) cntBuiltins.textContent = cat.builtins.length;
    }

    applyColorSelection(hexColor) {
        document.getElementById('input-solid-color').value = hexColor;
        document.getElementById('input-hex-text').value = hexColor.toUpperCase();

        if (this.assignTarget === 'brush') {
            this.materialManager.activeBrush.mode = 'color';
            this.materialManager.activeBrush.color = hexColor;
            this.godMode.sourceMode = 'brush';
            this.player.refreshHeldItemVisuals();
            this.renderHotbarUI();
        } else if (this.assignTarget === 'sky') {
            this.materialManager.skyConfig.mode = 'color';
            this.materialManager.skyConfig.color = hexColor;
            this.updateSkyAppearance();
            this.renderBiomeBlocksConfigUI();
            this.multiplayer.emitMaterialUpdate(null, null, this.materialManager.skyConfig);
        } else {
            const def = this.materialManager.getBlockDef(this.assignTarget);
            const newMode = (def && def.pattern === 'solid') ? 'solid' : 'voxel';
            const changes = { mode: newMode, color: hexColor };
            this.materialManager.updateBlockAppearance(this.assignTarget, changes);
            this.world.rebuildBlockTypeMesh(this.assignTarget);
            this.player.refreshHeldItemVisuals();
            this.renderHotbarUI();
            this.renderBiomeBlocksConfigUI();
            this.multiplayer.emitMaterialUpdate(this.assignTarget, changes);
        }
        this.updateActiveTargetSummary();
    }

    applyPatternSelection(pattern) {
        if (this.assignTarget === 'brush') {
            this.materialManager.activeBrush.mode = 'color';
            this.materialManager.activeBrush.pattern = pattern;
            this.godMode.sourceMode = 'brush';
            this.player.refreshHeldItemVisuals();
            this.renderHotbarUI();
        } else if (this.assignTarget !== 'sky') {
            const changes = {
                mode: pattern === 'solid' ? 'solid' : 'voxel',
                pattern
            };
            this.materialManager.updateBlockAppearance(this.assignTarget, changes);
            this.world.rebuildBlockTypeMesh(this.assignTarget);
            this.player.refreshHeldItemVisuals();
            this.renderHotbarUI();
            this.renderBiomeBlocksConfigUI();
            this.multiplayer.emitMaterialUpdate(this.assignTarget, changes);
        }
        this.updateActiveTargetSummary();
    }

    applyShaderSelection(kind, value, title, thumb = '') {
        if (this.assignTarget === 'brush') {
            this.materialManager.activeBrush.mode = 'shader';
            this.materialManager.activeBrush.shaderKind = kind;
            this.materialManager.activeBrush.shaderValue = value;
            this.materialManager.activeBrush.shaderTitle = title || value;
            this.materialManager.activeBrush.shaderThumb = thumb;
            this.godMode.sourceMode = 'brush';
            this.materialManager.getOrCreateBrushBlock();
            this.player.refreshHeldItemVisuals();
            this.renderHotbarUI();
            this.showToast(`✨ Pincel con Shader 1-Buffer: ${title || value}`);
        } else if (this.assignTarget === 'sky') {
            this.materialManager.skyConfig.mode = 'shader';
            this.materialManager.skyConfig.shaderKind = kind;
            this.materialManager.skyConfig.shaderValue = value;
            this.updateSkyAppearance();
            this.renderBiomeBlocksConfigUI();
            this.multiplayer.emitMaterialUpdate(null, null, this.materialManager.skyConfig);
            this.showToast(`🌌 Cielo con Shader: ${title || value}`);
        } else {
            const changes = {
                mode: 'shader',
                shaderKind: kind,
                shaderValue: value,
                shaderTitle: title || value,
                shaderThumb: thumb,
                emissive: true
            };
            this.materialManager.updateBlockAppearance(this.assignTarget, changes);
            this.world.rebuildBlockTypeMesh(this.assignTarget);
            this.player.refreshHeldItemVisuals();
            this.renderHotbarUI();
            this.renderBiomeBlocksConfigUI();
            this.multiplayer.emitMaterialUpdate(this.assignTarget, changes);
            const def = this.materialManager.getBlockDef(this.assignTarget);
            this.showToast(`✨ ${def ? def.name : this.assignTarget} usa Shader 1-Buffer: ${title || value}`);
        }

        this.updateActiveTargetSummary();
        this.renderShaderCatalogGrid();
        this.renderActiveShaderUniforms();
    }

    syncSidebarWithTarget() {
        const select = document.getElementById('select-assign-target');
        if (select) select.value = this.assignTarget;

        let color = '#38bdf8';
        let pattern = 'solid';

        if (this.assignTarget === 'brush') {
            color = this.materialManager.activeBrush.color;
            pattern = this.materialManager.activeBrush.pattern || 'solid';
        } else if (this.assignTarget === 'sky') {
            color = this.materialManager.skyConfig.color || '#7dd3fc';
        } else {
            const def = this.materialManager.getBlockDef(this.assignTarget);
            if (def) {
                color = def.color || '#56b847';
                pattern = def.mode === 'solid' ? 'solid' : (def.pattern || 'solid');
            }
        }

        document.getElementById('input-solid-color').value = color;
        document.getElementById('input-hex-text').value = color.toUpperCase();
        document.querySelectorAll('[data-voxel-pattern]').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-voxel-pattern') === pattern);
        });

        this.updateActiveTargetSummary();
        this.renderShaderCatalogGrid();
        this.renderActiveShaderUniforms();
    }

    updateActiveTargetSummary() {
        const summaryEl = document.getElementById('active-target-summary');
        if (!summaryEl) return;

        if (this.assignTarget === 'brush') {
            const b = this.materialManager.activeBrush;
            if (b.mode === 'shader') {
                summaryEl.innerHTML = `<span class="badge-shader">✨ 1-BUFFER</span> <b>${this.esc(b.shaderTitle || b.shaderValue)}</b>`;
            } else {
                summaryEl.innerHTML = `<span class="color-dot" data-dot-col="${this.esc(b.color)}"></span> <b>Color ${b.color.toUpperCase()}</b> <small>(${b.pattern})</small>`;
            }
        } else if (this.assignTarget === 'sky') {
            const s = this.materialManager.skyConfig;
            summaryEl.innerHTML = s.mode === 'shader'
                ? `<span class="badge-shader">🌌 SHADER CIELO</span> <b>${this.esc(s.shaderValue)}</b>`
                : `🌌 Cielo: <b>${s.mode === 'color' ? s.color : s.preset.toUpperCase()}</b>`;
        } else {
            const def = this.materialManager.getBlockDef(this.assignTarget);
            if (!def) return;
            if (def.mode === 'shader') {
                summaryEl.innerHTML = `${def.icon} <b>${def.name}</b> → <span class="badge-shader">✨ ${this.esc(def.shaderTitle || def.shaderValue)}</span>`;
            } else {
                summaryEl.innerHTML = `${def.icon} <b>${def.name}</b> → <span class="color-dot" data-dot-col="${this.esc(def.color)}"></span> <code>${def.color}</code> (${def.mode === 'solid' ? 'Sólido' : def.pattern})`;
            }
        }

        summaryEl.querySelectorAll('[data-dot-col]').forEach(el => {
            el.style.backgroundColor = el.getAttribute('data-dot-col');
        });
    }

    renderShaderCatalogGrid() {
        const grid = document.getElementById('shader-catalog-grid');
        if (!grid) return;

        const cat = window.jpShaderHub.catalog;
        let items = this.shaderTab === 'builtins' ? cat.builtins : cat.shaders;

        const q = this.norm(this.shaderSearchQuery).trim();
        if (q) {
            items = items.filter(it => this.norm(`${it.title} ${it.value} ${it.author} ${it.sub}`).includes(q));
        }

        const displayItems = items.slice(0, 120);

        let activeKind = '', activeVal = '';
        if (this.assignTarget === 'brush' && this.materialManager.activeBrush.mode === 'shader') {
            activeKind = this.materialManager.activeBrush.shaderKind;
            activeVal = this.materialManager.activeBrush.shaderValue;
        } else if (this.assignTarget === 'sky' && this.materialManager.skyConfig.mode === 'shader') {
            activeKind = this.materialManager.skyConfig.shaderKind;
            activeVal = this.materialManager.skyConfig.shaderValue;
        } else if (this.assignTarget !== 'brush' && this.assignTarget !== 'sky') {
            const def = this.materialManager.getBlockDef(this.assignTarget);
            if (def && def.mode === 'shader') {
                activeKind = def.shaderKind;
                activeVal = def.shaderValue;
            }
        }

        if (!displayItems.length) {
            grid.innerHTML = `<div class="empty-catalog-msg">${window.jpShaderHub.loadingCatalog ? '⏳ Indexando shaders 1-Buffer de jpshadereditorInclude…' : 'Sin resultados para tu búsqueda.'}</div>`;
            return;
        }

        grid.innerHTML = displayItems.map(it => {
            const isSelected = (it.kind === activeKind && it.value === activeVal);
            const badgeText = it.kind === 'builtin' ? 'LOCAL 1B' : '1-BUFFER';
            const thumbHtml = it.thumb
                ? `<img loading="lazy" class="shader-thumb-img" src="${this.esc(it.thumb)}" alt="${this.esc(it.title)}">`
                : `<div class="shader-thumb-fallback">✦ ${badgeText}</div>`;

            return `
                <div class="shader-card ${isSelected ? 'selected' : ''}"
                     data-sh-kind="${this.esc(it.kind)}"
                     data-sh-val="${this.esc(it.value)}"
                     data-sh-title="${this.esc(it.title)}"
                     data-sh-thumb="${this.esc(it.thumb || '')}">
                    <div class="shader-card-thumb">
                        ${thumbHtml}
                        <canvas class="shader-hover-canvas" width="128" height="128"></canvas>
                        <span class="shader-card-badge">${badgeText}</span>
                    </div>
                    <div class="shader-card-info">
                        <div class="shader-card-title" title="${this.esc(it.title)}">${this.esc(it.title)}</div>
                        <div class="shader-card-sub">${this.esc(it.sub)}</div>
                    </div>
                </div>
            `;
        }).join('');

        grid.querySelectorAll('.shader-thumb-img').forEach(img => {
            img.addEventListener('error', () => {
                img.style.display = 'none';
            });
        });

        grid.querySelectorAll('.shader-card').forEach(card => {
            const kind = card.getAttribute('data-sh-kind');
            const val = card.getAttribute('data-sh-val');
            const title = card.getAttribute('data-sh-title');
            const thumb = card.getAttribute('data-sh-thumb');
            const hoverCanvas = card.querySelector('.shader-hover-canvas');

            card.addEventListener('click', () => {
                this.applyShaderSelection(kind, val, title, thumb);
            });

            card.addEventListener('mouseenter', () => {
                if (hoverCanvas) {
                    hoverCanvas.style.opacity = '1';
                    window.jpShaderHub.startPreview(kind, val, hoverCanvas);
                }
            });

            card.addEventListener('mouseleave', () => {
                if (hoverCanvas) {
                    hoverCanvas.style.opacity = '0';
                }
                window.jpShaderHub.stopPreview();
            });
        });
    }

    renderActiveShaderUniforms() {
        const cont = document.getElementById('active-shader-uniforms');
        if (!cont) return;

        let kind = '', val = '';
        if (this.assignTarget === 'brush' && this.materialManager.activeBrush.mode === 'shader') {
            kind = this.materialManager.activeBrush.shaderKind;
            val = this.materialManager.activeBrush.shaderValue;
        } else if (this.assignTarget === 'sky' && this.materialManager.skyConfig.mode === 'shader') {
            kind = this.materialManager.skyConfig.shaderKind;
            val = this.materialManager.skyConfig.shaderValue;
        } else if (this.assignTarget !== 'brush' && this.assignTarget !== 'sky') {
            const def = this.materialManager.getBlockDef(this.assignTarget);
            if (def && def.mode === 'shader') {
                kind = def.shaderKind;
                val = def.shaderValue;
            }
        }

        if (!kind || !val) {
            cont.innerHTML = '';
            return;
        }

        const key = `${kind}:${val}`;
        const entry = window.jpShaderHub.entries.get(key);
        if (!entry || !entry.uniforms || Object.keys(entry.uniforms).length === 0) {
            cont.innerHTML = '';
            return;
        }

        const uNames = Object.keys(entry.uniforms);
        cont.innerHTML = `
            <div class="uniforms-box-header">
                <span>🎛️ Uniforms en Vivo (${this.esc(val)})</span>
                <button class="btn-mini-ghost" id="btn-reset-shader-uniforms">↺ Reset</button>
            </div>
            <div class="uniforms-sliders-list">
                ${uNames.map(uName => {
                    const u = entry.uniforms[uName];
                    const numVal = Array.isArray(u.value) ? Number(u.value[0] || 0) : Number(u.value || 0);
                    return `
                        <div class="uniform-slider-item">
                            <label>
                                <span>${this.esc(uName)}</span>
                                <b data-u-val="${this.esc(uName)}">${numVal.toFixed(2)}</b>
                            </label>
                            <input type="range" min="0" max="2" step="0.02" value="${numVal}" data-u-slider="${this.esc(uName)}">
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        cont.querySelectorAll('[data-u-slider]').forEach(slider => {
            slider.addEventListener('input', () => {
                const uName = slider.getAttribute('data-u-slider');
                const v = parseFloat(slider.value);
                window.jpShaderHub.setEntryUniform(key, uName, v);
                const lbl = cont.querySelector(`[data-u-val="${uName}"]`);
                if (lbl) lbl.textContent = v.toFixed(2);
            });
        });

        const resetBtn = cont.querySelector('#btn-reset-shader-uniforms');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                window.jpShaderHub.resetEntryUniforms(key);
                this.renderActiveShaderUniforms();
            });
        }
    }

    // =========================================================================
    // REQUERIMIENTO #4: INVENTARIO COMPLETO ESTILO MINECRAFT
    // =========================================================================
    initInventoryModalUI() {
        document.querySelectorAll('[data-inv-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.inventoryTab = btn.getAttribute('data-inv-tab');
                document.querySelectorAll('[data-inv-tab]').forEach(b => b.classList.toggle('active', b === btn));
                this.renderInventoryModalUI();
            });
        });
    }

    isInventoryOpen() {
        const modal = document.getElementById('inventory-modal-backdrop');
        return modal ? modal.classList.contains('open') : false;
    }

    toggleInventoryModal(forceState) {
        const modal = document.getElementById('inventory-modal-backdrop');
        if (!modal) return;
        const isOpen = modal.classList.contains('open');
        const next = forceState !== undefined ? forceState : !isOpen;
        if (next && document.pointerLockElement) {
            document.exitPointerLock();
        }
        modal.classList.toggle('open', next);
        if (next) {
            this.renderInventoryModalUI();
        }
    }

    renderInventoryModalUI() {
        const grid = document.getElementById('inventory-items-grid');
        const strip = document.getElementById('inventory-hotbar-strip');
        if (!grid || !strip) return;

        const equippedIds = new Set(
            this.player.hotbar.filter(s => s.type === 'block').map(s => s.id)
        );

        const cards = [];

        // 1. Bloques del Bioma y bloques personalizados ya registrados
        if (this.inventoryTab === 'all' || this.inventoryTab === 'biome') {
            for (const [bId, def] of this.materialManager.blocks.entries()) {
                if (this.inventoryTab === 'biome' && def.category === 'custom') continue;
                const iconUrl = this.materialManager.previewIcons.get(bId) || '';
                const count = this.player.getInventoryCount(bId);
                cards.push({
                    action: 'block',
                    blockId: bId,
                    name: def.name,
                    tag: def.mode === 'shader' ? '1-BUFFER' : (def.category === 'custom' ? 'CUSTOM' : 'BIOMA'),
                    iconUrl,
                    emoji: def.icon || '🧊',
                    color: def.color || '#38bdf8',
                    count,
                    equipped: equippedIds.has(bId)
                });
            }
        }

        // 2. Shaders de 1-Buffer listos para equipar como cubos
        if (this.inventoryTab === 'all' || this.inventoryTab === 'shaders') {
            const cat = window.jpShaderHub.catalog;
            const shaderItems = [...cat.builtins, ...cat.shaders.slice(0, 36)];
            for (const sh of shaderItems) {
                const cleanVal = String(sh.value).replace(/[^a-zA-Z0-9_-]/g, '_');
                const potentialId = `custom_sh_${sh.kind}_${cleanVal}`;
                const iconUrl = this.materialManager.previewIcons.get(potentialId) || sh.thumb || '';
                cards.push({
                    action: 'shader',
                    shaderKind: sh.kind,
                    shaderValue: sh.value,
                    shaderTitle: sh.title,
                    shaderThumb: sh.thumb || '',
                    name: sh.title,
                    tag: sh.kind === 'builtin' ? 'LOCAL 1-BUF' : 'GLSL 1-BUF',
                    iconUrl,
                    emoji: '✨',
                    color: '#a855f7',
                    count: 64,
                    equipped: equippedIds.has(potentialId)
                });
            }
        }

        // 3. Cubos de Colores Sólidos y Patrones Voxel
        if (this.inventoryTab === 'all' || this.inventoryTab === 'colors') {
            const presetCubes = [
                { color: '#38bdf8', pattern: 'crystal', name: 'Cristal Diamante' },
                { color: '#ec4899', pattern: 'crystal', name: 'Cristal Rubí Neón' },
                { color: '#a855f7', pattern: 'crystal', name: 'Cristal Amatista' },
                { color: '#22c55e', pattern: 'crystal', name: 'Cristal Esmeralda' },
                { color: '#f59e0b', pattern: 'brick', name: 'Ladrillo Dorado' },
                { color: '#ef4444', pattern: 'brick', name: 'Ladrillo Rojo' },
                { color: '#64748b', pattern: 'brick', name: 'Ladrillo Fortaleza' },
                { color: '#f8fafc', pattern: 'solid', name: 'Cuarzo Blanco' },
                { color: '#1e293b', pattern: 'solid', name: 'Obsidiana Oscura' },
                { color: '#eab308', pattern: 'solid', name: 'Bloque de Oro' },
                { color: '#06b6d4', pattern: 'solid', name: 'Bloque Turquesa' },
                { color: '#f97316', pattern: 'solid', name: 'Terracota Naranja' }
            ];
            for (const pc of presetCubes) {
                const hexClean = pc.color.replace('#', '').toLowerCase();
                const potentialId = `custom_col_${hexClean}_${pc.pattern}`;
                cards.push({
                    action: 'color',
                    color: pc.color,
                    pattern: pc.pattern,
                    name: pc.name,
                    tag: pc.pattern.toUpperCase(),
                    iconUrl: this.materialManager.previewIcons.get(potentialId) || '',
                    emoji: '🎨',
                    count: 64,
                    equipped: equippedIds.has(potentialId)
                });
            }
        }

        grid.innerHTML = cards.map((c, i) => `
            <div class="inv-item-card ${c.equipped ? 'equipped' : ''}" data-inv-idx="${i}">
                <span class="inv-item-count">${c.count}</span>
                <div class="inv-item-thumb" data-thumb-url="${this.esc(c.iconUrl)}" data-thumb-col="${this.esc(c.color)}">
                    ${c.iconUrl ? '' : c.emoji}
                </div>
                <div class="inv-item-name" title="${this.esc(c.name)}">${this.esc(c.name)}</div>
                <span class="inv-item-tag">${this.esc(c.tag)}</span>
            </div>
        `).join('');

        grid.querySelectorAll('.inv-item-thumb').forEach(el => {
            const url = el.getAttribute('data-thumb-url');
            const col = el.getAttribute('data-thumb-col');
            if (url) {
                el.style.backgroundImage = `url('${url}')`;
            } else if (col) {
                el.style.backgroundColor = col;
            }
        });

        grid.querySelectorAll('.inv-item-card').forEach(cardEl => {
            cardEl.addEventListener('click', () => {
                const idx = parseInt(cardEl.getAttribute('data-inv-idx'), 10);
                const item = cards[idx];
                if (!item) return;

                let blockDef;
                if (item.action === 'block') {
                    blockDef = this.materialManager.getBlockDef(item.blockId);
                } else if (item.action === 'shader') {
                    blockDef = this.materialManager.getOrCreateShaderBlock(
                        item.shaderKind,
                        item.shaderValue,
                        item.shaderTitle,
                        item.shaderThumb,
                        true
                    );
                } else if (item.action === 'color') {
                    blockDef = this.materialManager.getOrCreateColorBlock(item.color, item.pattern);
                }

                if (blockDef) {
                    const selSlotEl = document.getElementById('select-inv-target-slot');
                    const selVal = selSlotEl ? selSlotEl.value : 'auto';
                    const targetSlot = selVal === 'auto' ? null : parseInt(selVal, 10);
                    const equippedSlotIdx = this.player.equipBlockInHotbar(blockDef.id, targetSlot);
                    this.showToast(`🎒 Equipado "${blockDef.name}" en Tecla [${equippedSlotIdx + 1}]`);
                    this.renderInventoryModalUI();
                }
            });
        });

        // Renderizar tira de Hotbar interactiva dentro del modal de Inventario
        const selSlotEl = document.getElementById('select-inv-target-slot');
        const currentTargetVal = selSlotEl ? selSlotEl.value : 'auto';

        strip.innerHTML = this.player.hotbar.map((slot, idx) => {
            const isTarget = String(idx) === String(currentTargetVal) || (currentTargetVal === 'auto' && idx === this.player.activeSlot);
            let label = slot.type === 'tool' ? 'Pico' : slot.type === 'brush' ? 'Pincel' : (this.materialManager.getBlockDef(slot.id)?.name || slot.id);
            return `
                <button class="hotbar-slot ${isTarget ? 'active' : ''}" data-inv-hb-slot="${idx}" title="Slot ${idx + 1}: ${this.esc(label)}">
                    <span class="hotbar-key">${idx + 1}</span>
                    <span class="hotbar-emoji">${slot.type === 'tool' ? '⛏️' : slot.type === 'brush' ? '✨' : '🧊'}</span>
                    <span class="hotbar-label">${this.esc(label)}</span>
                </button>
            `;
        }).join('');

        strip.querySelectorAll('[data-inv-hb-slot]').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-inv-hb-slot'), 10);
                if (idx >= 1 && idx <= 6 && selSlotEl) {
                    selSlotEl.value = String(idx);
                }
                this.player.selectHotbarSlot(idx);
                this.renderInventoryModalUI();
            });
        });
    }

    // =========================================================================
    // INTERFAZ DE CREACIÓN DE BIOMA AMPLIO
    // =========================================================================
    initBiomeCreatorUI() {
        document.querySelectorAll('[data-biome-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.getAttribute('data-biome-preset');
                this.world.biomeParams.preset = preset;
                document.querySelectorAll('[data-biome-preset]').forEach(b => b.classList.toggle('active', b === btn));
            });
        });

        const selSize = document.getElementById('biome-select-size');
        selSize.addEventListener('change', () => {
            this.world.biomeParams.size = parseInt(selSize.value, 10) || 64;
        });

        const bindSlider = (id, valId, paramKey, isFloat = false) => {
            const sl = document.getElementById(id);
            const vl = document.getElementById(valId);
            if (!sl) return;
            sl.addEventListener('input', () => {
                const v = isFloat ? parseFloat(sl.value) : parseInt(sl.value, 10);
                this.world.biomeParams[paramKey] = v;
                if (vl) vl.textContent = isFloat ? `${Math.round(v * 100)}%` : v;
            });
        };

        bindSlider('biome-slider-hills', 'val-biome-hills', 'hillHeight', false);
        bindSlider('biome-slider-trees', 'val-biome-trees', 'treeDensity', true);
        bindSlider('biome-slider-stone', 'val-biome-stone', 'stoneAbundance', true);
        bindSlider('biome-slider-water', 'val-biome-water', 'waterLevel', false);

        const seedInput = document.getElementById('biome-input-seed');
        seedInput.value = this.world.biomeParams.seed;
        seedInput.addEventListener('change', () => {
            this.world.biomeParams.seed = parseInt(seedInput.value, 10) || 12345;
        });

        document.getElementById('btn-random-seed').addEventListener('click', () => {
            const newSeed = Math.floor(Math.random() * 999999);
            this.world.biomeParams.seed = newSeed;
            seedInput.value = newSeed;
        });

        document.getElementById('btn-generate-biome').addEventListener('click', () => {
            this.world.generateBiome();
            this.player.spawnAtCenter();
            this.updateSkyAppearance();
            this.renderBiomeBlocksConfigUI();
            this.renderHotbarUI();

            // Sincronizar nuevo bioma con todos los jugadores conectados por Socket.IO
            const matCfg = this.materialManager.serializeConfig();
            this.multiplayer.emitBiomeGenerate(this.world.biomeParams, matCfg.blocks, matCfg.skyConfig);

            this.showToast(`🌍 ¡Bioma Amplio (${this.world.biomeParams.size}×${this.world.biomeParams.size}) Generado!`);
            this.toggleBiomeModal(false);
        });

        document.getElementById('btn-randomize-biome-shaders').addEventListener('click', () => {
            this.randomizeBiomeShaders();
        });

        document.getElementById('btn-reset-classic-biome').addEventListener('click', () => {
            this.materialManager.initDefaultBiomeBlocks();
            this.materialManager.skyConfig.mode = 'preset';
            this.materialManager.skyConfig.preset = 'day';
            this.updateSkyAppearance();
            this.world.rebuildAllMeshes();
            this.renderBiomeBlocksConfigUI();
            this.renderHotbarUI();
            const matCfg = this.materialManager.serializeConfig();
            this.multiplayer.emitBiomeGenerate(this.world.biomeParams, matCfg.blocks, matCfg.skyConfig);
            this.showToast('🌿 Texturas clásicas de Minecraft restauradas');
        });
    }

    syncBiomeCreatorInputsWithWorld() {
        const bp = this.world.biomeParams;
        const selSize = document.getElementById('biome-select-size');
        if (selSize) selSize.value = String(bp.size || 64);
        const seedInput = document.getElementById('biome-input-seed');
        if (seedInput) seedInput.value = bp.seed || 12345;
        document.querySelectorAll('[data-biome-preset]').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-biome-preset') === bp.preset);
        });
    }

    randomizeBiomeShaders() {
        const cat = window.jpShaderHub.catalog;
        // REQUERIMIENTO #3: Exclusivamente shaders de 1 solo buffer verificados
        const pool = [...cat.builtins, ...cat.shaders.slice(0, 45)];
        if (!pool.length) return;

        const pickRandom = () => pool[Math.floor(Math.random() * pool.length)];
        const targets = ['grass', 'stone', 'wood', 'leaves', 'water'];

        for (const t of targets) {
            const item = pickRandom();
            const changes = {
                mode: 'shader',
                shaderKind: item.kind,
                shaderValue: item.value,
                shaderTitle: item.title,
                shaderThumb: item.thumb || '',
                emissive: true
            };
            this.materialManager.updateBlockAppearance(t, changes);
            this.multiplayer.emitMaterialUpdate(t, changes);
        }

        this.world.rebuildAllMeshes();
        this.renderBiomeBlocksConfigUI();
        this.renderHotbarUI();
        this.showToast('✨ Shaders 1-Buffer aleatorios asignados al Bioma');
    }

    renderBiomeBlocksConfigUI() {
        const container = document.getElementById('biome-elements-list');
        if (!container) return;

        const biomeBlockIds = ['grass', 'stone', 'wood', 'leaves', 'dirt', 'water', 'sand'];
        const cardsHtml = biomeBlockIds.map(id => {
            const def = this.materialManager.getBlockDef(id);
            const iconUrl = this.materialManager.previewIcons.get(id) || '';
            const isVoxel = def.mode === 'voxel';
            const isSolid = def.mode === 'solid';
            const isShader = def.mode === 'shader';

            return `
                <div class="biome-element-card" data-biome-block="${id}">
                    <div class="biome-el-header">
                        <div class="biome-el-preview" data-bg-url="${this.esc(iconUrl)}"></div>
                        <div class="biome-el-title-wrap">
                            <h4>${def.icon} ${this.esc(def.name)}</h4>
                            <span class="biome-el-status">
                                ${isShader
                                    ? `✨ 1-Buffer: <b>${this.esc(def.shaderTitle || def.shaderValue)}</b>`
                                    : isSolid
                                        ? `🎨 Color Sólido: <b>${def.color}</b>`
                                        : `🧱 Textura Voxel (${def.pattern})`
                                }
                            </span>
                        </div>
                        <input type="color" class="biome-el-color" data-el-color="${id}" value="${def.color}" title="Cambiar color de ${this.esc(def.name)}">
                    </div>
                    <div class="biome-el-actions">
                        <button class="btn-el-mode ${isVoxel ? 'active' : ''}" data-el-mode="${id}|voxel">🧱 Voxel</button>
                        <button class="btn-el-mode ${isSolid ? 'active' : ''}" data-el-mode="${id}|solid">🎨 Sólido</button>
                        <button class="btn-el-mode ${isShader ? 'active' : ''}" data-el-pickshader="${id}">✨ Shader 1-Buf…</button>
                    </div>
                </div>
            `;
        }).join('');

        const sky = this.materialManager.skyConfig;
        const skyHtml = `
            <div class="biome-element-card" data-biome-block="sky">
                <div class="biome-el-header">
                    <div class="biome-el-preview" data-bg-col="${this.esc(sky.color)}"></div>
                    <div class="biome-el-title-wrap">
                        <h4>🌌 Cielo / Atmósfera</h4>
                        <span class="biome-el-status">
                            ${sky.mode === 'shader'
                                ? `✨ Shader: <b>${this.esc(sky.shaderValue)}</b>`
                                : `Atmósfera: <b>${sky.preset.toUpperCase()}</b>`
                            }
                        </span>
                    </div>
                    <input type="color" class="biome-el-color" data-el-color="sky" value="${sky.color}" title="Color del Cielo">
                </div>
                <div class="biome-el-actions">
                    <button class="btn-el-mode ${sky.mode === 'preset' && sky.preset === 'day' ? 'active' : ''}" data-sky-preset="day">☀️ Día</button>
                    <button class="btn-el-mode ${sky.mode === 'preset' && sky.preset === 'sunset' ? 'active' : ''}" data-sky-preset="sunset">🌅 Tarde</button>
                    <button class="btn-el-mode ${sky.mode === 'preset' && sky.preset === 'night' ? 'active' : ''}" data-sky-preset="night">🌙 Noche</button>
                    <button class="btn-el-mode ${sky.mode === 'shader' ? 'active' : ''}" data-el-pickshader="sky">✨ Shader Cielo…</button>
                </div>
            </div>
        `;

        container.innerHTML = cardsHtml + skyHtml;

        container.querySelectorAll('[data-bg-url]').forEach(el => {
            const url = el.getAttribute('data-bg-url');
            if (url) el.style.backgroundImage = `url('${url}')`;
        });
        container.querySelectorAll('[data-bg-col]').forEach(el => {
            const col = el.getAttribute('data-bg-col');
            if (col) el.style.backgroundColor = col;
        });

        container.querySelectorAll('[data-el-color]').forEach(inp => {
            inp.addEventListener('input', () => {
                const id = inp.getAttribute('data-el-color');
                if (id === 'sky') {
                    this.materialManager.skyConfig.mode = 'color';
                    this.materialManager.skyConfig.color = inp.value;
                    this.updateSkyAppearance();
                    this.multiplayer.emitMaterialUpdate(null, null, this.materialManager.skyConfig);
                } else {
                    const def = this.materialManager.getBlockDef(id);
                    const nextMode = def.mode === 'shader' ? 'voxel' : def.mode;
                    const changes = { mode: nextMode, color: inp.value };
                    this.materialManager.updateBlockAppearance(id, changes);
                    this.world.rebuildBlockTypeMesh(id);
                    this.renderHotbarUI();
                    this.multiplayer.emitMaterialUpdate(id, changes);
                }
            });
            inp.addEventListener('change', () => this.renderBiomeBlocksConfigUI());
        });

        container.querySelectorAll('[data-el-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                const [id, mode] = btn.getAttribute('data-el-mode').split('|');
                const defaultPatterns = {
                    grass: 'grass', dirt: 'dirt', stone: 'stone',
                    wood: 'wood', leaves: 'leaves', water: 'water', sand: 'sand'
                };
                const changes = {
                    mode,
                    pattern: mode === 'solid' ? 'solid' : (defaultPatterns[id] || 'stone')
                };
                this.materialManager.updateBlockAppearance(id, changes);
                this.world.rebuildBlockTypeMesh(id);
                this.renderBiomeBlocksConfigUI();
                this.renderHotbarUI();
                this.multiplayer.emitMaterialUpdate(id, changes);
            });
        });

        container.querySelectorAll('[data-sky-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.materialManager.skyConfig.mode = 'preset';
                this.materialManager.skyConfig.preset = btn.getAttribute('data-sky-preset');
                this.updateSkyAppearance();
                this.renderBiomeBlocksConfigUI();
                this.multiplayer.emitMaterialUpdate(null, null, this.materialManager.skyConfig);
            });
        });

        container.querySelectorAll('[data-el-pickshader]').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.getAttribute('data-el-pickshader');
                this.assignTarget = targetId;
                this.syncSidebarWithTarget();

                const sidebar = document.getElementById('studio-sidebar');
                sidebar.classList.remove('collapsed');
                document.querySelector('[data-studio-tab="shader"]')?.click();
                this.toggleBiomeModal(false);
                this.showToast(`🎯 Elegí un Shader 1-Buffer en el panel derecho para: ${targetId.toUpperCase()}`);
            });
        });
    }

    toggleBiomeModal(forceState) {
        const modal = document.getElementById('biome-modal-backdrop');
        if (!modal) return;
        const isOpen = modal.classList.contains('open');
        const next = forceState !== undefined ? forceState : !isOpen;
        if (next && document.pointerLockElement) {
            document.exitPointerLock();
        }
        modal.classList.toggle('open', next);
        if (next) {
            this.renderBiomeBlocksConfigUI();
        }
    }

    renderHotbarUI() {
        const bar = document.getElementById('hotbar-container');
        if (!bar) return;

        bar.innerHTML = this.player.hotbar.map((slot, idx) => {
            const isActive = idx === this.player.activeSlot;
            let iconHtml = '';
            let label = '';
            let countBadge = '';

            if (slot.type === 'tool') {
                iconHtml = `<span class="hotbar-emoji">⛏️</span>`;
                label = 'Pico';
            } else if (slot.type === 'brush') {
                const b = this.materialManager.activeBrush;
                if (b.mode === 'shader') {
                    iconHtml = `<span class="hotbar-emoji">✨</span>`;
                    label = 'Shader 1B';
                } else {
                    iconHtml = `<span class="hotbar-color-box" data-hb-col="${this.esc(b.color)}"></span>`;
                    label = 'Pincel';
                }
            } else {
                const def = this.materialManager.getBlockDef(slot.id);
                const iconUrl = this.materialManager.previewIcons.get(slot.id) || '';
                iconHtml = iconUrl
                    ? `<div class="hotbar-tex-icon" data-hb-url="${this.esc(iconUrl)}"></div>`
                    : `<span class="hotbar-emoji">${def ? def.icon : '🧊'}</span>`;
                label = def ? def.name.split(' ')[0] : slot.id;
                countBadge = isFinite(slot.count) ? `<span class="hotbar-count">${slot.count}</span>` : `<span class="hotbar-count">∞</span>`;
            }

            return `
                <button class="hotbar-slot ${isActive ? 'active' : ''}" data-slot-idx="${idx}" title="${this.esc(label)} (Tecla ${idx + 1})">
                    <span class="hotbar-key">${idx + 1}</span>
                    ${iconHtml}
                    ${countBadge}
                    <span class="hotbar-label">${this.esc(label)}</span>
                </button>
            `;
        }).join('');

        bar.querySelectorAll('[data-hb-col]').forEach(el => {
            el.style.backgroundColor = el.getAttribute('data-hb-col');
        });
        bar.querySelectorAll('[data-hb-url]').forEach(el => {
            el.style.backgroundImage = `url('${el.getAttribute('data-hb-url')}')`;
        });

        bar.querySelectorAll('.hotbar-slot').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-slot-idx'), 10);
                this.player.selectHotbarSlot(idx);
                if (this.mode === 'god') {
                    const item = this.player.getActiveHotbarItem();
                    this.godMode.sourceMode = (item && item.type === 'block') ? 'hotbar' : 'brush';
                }
            });
        });
    }

    updateModeUI() {
        const isUser = this.mode === 'user';
        document.getElementById('btn-mode-user').classList.toggle('active', isUser);
        document.getElementById('btn-mode-god').classList.toggle('active', !isUser);

        document.getElementById('god-toolbar').style.display = isUser ? 'none' : 'flex';
        document.getElementById('user-subcontrols').style.display = isUser ? 'flex' : 'none';
        document.getElementById('crosshair').style.display = isUser ? 'block' : 'none';

        const lockHint = document.getElementById('pointerlock-hint');
        if (lockHint) {
            lockHint.style.display = (isUser && !this.player.isPointerLocked) ? 'flex' : 'none';
        }

        const btnCam = document.getElementById('btn-toggle-cam');
        if (btnCam) {
            btnCam.textContent = this.player.thirdPerson ? '👁️ 3ª Persona [V]' : '👁️ 1ª Persona [V]';
        }

        const btnFly = document.getElementById('btn-toggle-fly');
        if (btnFly) {
            btnFly.textContent = this.player.isFlying ? '🕊️ Vuelo 3D: ON [F]' : '🚶 Caminar [F]';
            btnFly.classList.toggle('active', this.player.isFlying);
        }

        const helpText = document.getElementById('controls-footer-hint');
        if (helpText) {
            helpText.innerHTML = isUser
                ? `<b>MODO JUEGO:</b> <kbd>WASD</kbd> Moverse · <kbd>Espacio</kbd> Saltar · <kbd>I</kbd>/<kbd>E</kbd> Inventario · <kbd>F</kbd> Vuelo 3D · <kbd>V</kbd> 1ª/3ª Persona · <b>Click Izq</b> Picar · <b>Click Der</b> Poner Cubo · <kbd>Tab</kbd> Modo Dios`
                : `<b>MODO DIOS:</b> <kbd>Q</kbd> Bajar Altura · <kbd>E</kbd> Subir Altura · <kbd>WASD</kbd> Mover Cámara · <b>Click Izq</b> Poner Cubos · <b>Click Der</b> Rotar Vista / Borrar · <kbd>I</kbd> Inventario · <kbd>Tab</kbd> Modo Juego`;
        }
    }

    showToast(msg) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'voxel-toast';
        toast.textContent = msg;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 2400);
    }

    exportWorldJson() {
        const data = this.world.serializeWorld();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `shadercraft_mundo_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('💾 Mundo exportado a JSON');
    }

    importWorldJson(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.addEventListener('load', (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (this.world.deserializeWorld(data)) {
                    this.updateSkyAppearance();
                    this.player.spawnAtCenter();
                    this.renderHotbarUI();
                    this.renderBiomeBlocksConfigUI();
                    this.showToast('📂 Mundo cargado correctamente');
                }
            } catch (err) {
                this.showToast('⚠️ Archivo JSON inválido');
            }
        });
        reader.readAsText(file);
        e.target.value = '';
    }

    norm(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // =========================================================================
    // LOOP DE ANIMACIÓN Y RENDERIZADO
    // =========================================================================
    animate(now) {
        requestAnimationFrame(this.animate);

        const dt = Math.min(0.08, (now - this.lastTime) / 1000);
        this.lastTime = now;

        // 1. Actualizar texturas de los Shaders 1-Buffer activos
        const activeShaderKeys = this.materialManager.getActiveShaderKeys();
        window.jpShaderHub.updateActiveShaders(activeShaderKeys);

        // 2. Actualizar controlador del Modo Activo (Modo Usuario 3D vs Modo Dios desde arriba)
        this.player.update(dt, this.mode === 'user');
        this.godMode.update(dt, this.mode === 'god');

        // 3. Actualizar sincronización Multijugador Socket.IO y avatares remotos
        this.multiplayer.update(dt, this.mode);

        if (this.mode === 'user') {
            const p = this.player.position;
            const el = document.getElementById('hud-coords');
            if (el) {
                const hitTxt = (this.player.targetedHit && this.player.targetedHit.blockId)
                    ? ` · Mirando: [${this.player.targetedHit.blockId}]`
                    : '';
                el.textContent = `XYZ: ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}${hitTxt}`;
            }
        }

        if (this.skySphere.visible) {
            this.skySphere.position.copy(this.camera.position);
        }

        // 4. Renderizar escena 3D Three.js
        this.renderer.render(this.scene, this.camera);

        // 5. Contador de FPS
        this.frames++;
        if (now - this.lastFpsUpdate >= 1000) {
            const fps = Math.round((this.frames * 1000) / (now - this.lastFpsUpdate));
            this.frames = 0;
            this.lastFpsUpdate = now;
            const fpsEl = document.getElementById('hud-fps');
            if (fpsEl) fpsEl.textContent = `${fps} FPS`;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new VoxelCraftShaderApp();
});
