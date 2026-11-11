/**
 * MaterialManager — Gestor de Materiales, Texturas Voxel Procedurales, Colores Sólidos y Shaders 1-Buffer (jpshadereditorInclude)
 * -------------------------------------------------------------------------------------------------------------------------------
 * Permite que cualquier bloque del bioma (Pasto, Tierra, Piedra, Madera, Hojas, Agua, Arena) o cualquier cubo
 * personalizado puesto en Modo Dios / Modo Juego / Inventario tenga:
 *   1) Un Color Sólido (con biselado sutil de voxel para lectura 3D limpia)
 *   2) Una Textura Voxel Pixel-Art Procedural coloreada (Pasto, Piedra, Madera, Hojas, Ladrillo, Cristal, Tierra)
 *   3) Un Shader de 1-Buffer en vivo de jpshadereditorInclude (Galería de Shaders 1-Buffer o Locales 1-Buffer)
 */
class MaterialManager {
    constructor(shaderHub) {
        this.shaderHub = shaderHub;
        this.blocks = new Map();       // blockId -> BlockDef
        this.materials = new Map();    // blockId -> THREE.Material | THREE.Material[]
        this.previewIcons = new Map(); // blockId -> dataURL 2D icon para UI / Hotbar / Inventario
        this.onIconsUpdated = null;

        // Estado del Cielo / Fondo del Bioma
        this.skyConfig = {
            mode: 'preset', // 'preset' | 'color' | 'shader'
            preset: 'day',  // 'day' | 'sunset' | 'night' | 'cyber'
            color: '#7dd3fc',
            shaderKind: 'builtin',
            shaderValue: 'sunset_sky_aurora'
        };

        // Pincel activo para poner cubos (Modo Dios y Modo Usuario)
        this.activeBrush = {
            mode: 'color',          // 'color' | 'voxel' | 'shader'
            color: '#38bdf8',
            pattern: 'solid',       // 'solid' | 'brick' | 'crystal' | 'stone' | 'wood' | 'grass'
            shaderKind: 'builtin',
            shaderValue: 'plasma_neon',
            shaderTitle: 'Plasma Neón Fluido',
            shaderThumb: '',
            emissive: true
        };

        this.initDefaultBiomeBlocks();

        if (this.shaderHub && typeof this.shaderHub.onEntryRendered === 'function') {
            this.shaderHub.onEntryRendered((entry) => {
                let changed = false;
                for (const [blockId, def] of this.blocks.entries()) {
                    if (def.mode === 'shader' && `${def.shaderKind || 'shader'}:${def.shaderValue}` === entry.key) {
                        try {
                            this.previewIcons.set(blockId, entry.canvas2d.toDataURL());
                            changed = true;
                        } catch (e) {
                            // Ignore canvas taint if any
                        }
                    }
                }
                if (changed && typeof this.onIconsUpdated === 'function') {
                    this.onIconsUpdated();
                }
            });
        }
    }

    initDefaultBiomeBlocks() {
        const defaults = [
            {
                id: 'grass',
                name: 'Pasto (Piso)',
                icon: '🌿',
                category: 'grass',
                mode: 'voxel',
                color: '#56b847',
                secondaryColor: '#79553a',
                pattern: 'grass',
                shaderKind: 'builtin',
                shaderValue: 'bio_forest',
                emissive: false
            },
            {
                id: 'dirt',
                name: 'Tierra (Subsuelo)',
                icon: '🟫',
                category: 'dirt',
                mode: 'voxel',
                color: '#865d3b',
                pattern: 'dirt',
                shaderKind: 'builtin',
                shaderValue: 'lava_magma',
                emissive: false
            },
            {
                id: 'stone',
                name: 'Piedra (Roca)',
                icon: '🪨',
                category: 'stone',
                mode: 'voxel',
                color: '#848c94',
                pattern: 'stone',
                shaderKind: 'builtin',
                shaderValue: 'runic_stone',
                emissive: false
            },
            {
                id: 'wood',
                name: 'Madera (Árbol)',
                icon: '🪵',
                category: 'wood',
                mode: 'voxel',
                color: '#7c5330',
                secondaryColor: '#b88b5a',
                pattern: 'wood',
                shaderKind: 'builtin',
                shaderValue: 'plasma_neon',
                emissive: false
            },
            {
                id: 'leaves',
                name: 'Hojas (Copa)',
                icon: '🍃',
                category: 'leaves',
                mode: 'voxel',
                color: '#368f36',
                pattern: 'leaves',
                shaderKind: 'builtin',
                shaderValue: 'bio_forest',
                emissive: false
            },
            {
                id: 'water',
                name: 'Agua / Cristal',
                icon: '💧',
                category: 'water',
                mode: 'voxel',
                color: '#2998f2',
                pattern: 'water',
                shaderKind: 'builtin',
                shaderValue: 'water_caustics',
                emissive: false,
                transparent: true,
                opacity: 0.85
            },
            {
                id: 'sand',
                name: 'Arena / Orilla',
                icon: '🏖️',
                category: 'sand',
                mode: 'voxel',
                color: '#e3cf8a',
                pattern: 'sand',
                shaderKind: 'builtin',
                shaderValue: 'cyber_grid',
                emissive: false
            }
        ];

        for (const def of defaults) {
            this.blocks.set(def.id, def);
            this.rebuildMaterial(def.id);
        }
    }

    getBlockDef(blockId) {
        return this.blocks.get(blockId) || this.blocks.get('grass');
    }

    getMaterial(blockId) {
        if (!this.materials.has(blockId)) {
            this.rebuildMaterial(blockId);
        }
        return this.materials.get(blockId);
    }

    /**
     * Registra un bloque personalizado recibido por red o desde el inventario
     */
    registerCustomBlockDef(def) {
        if (!def || !def.id) return null;
        this.blocks.set(def.id, { ...def });
        this.rebuildMaterial(def.id);
        return this.blocks.get(def.id);
    }

    /**
     * Crea o recupera un bloque de shader 1-buffer directamente (ej. desde el Inventario)
     */
    getOrCreateShaderBlock(shaderKind, shaderValue, shaderTitle, shaderThumb = '', emissive = true) {
        const cleanVal = String(shaderValue).replace(/[^a-zA-Z0-9_-]/g, '_');
        const id = `custom_sh_${shaderKind}_${cleanVal}`;
        if (!this.blocks.has(id)) {
            const def = {
                id,
                name: `Shader: ${shaderTitle || shaderValue}`,
                icon: '✨',
                category: 'custom',
                mode: 'shader',
                color: '#38bdf8',
                pattern: 'solid',
                shaderKind: shaderKind || 'shader',
                shaderValue,
                shaderTitle: shaderTitle || shaderValue,
                shaderThumb: shaderThumb || '',
                emissive: emissive !== false
            };
            this.blocks.set(id, def);
            this.rebuildMaterial(id);
        }
        return this.blocks.get(id);
    }

    /**
     * Crea o recupera un bloque de color sólido / patrón voxel directamente
     */
    getOrCreateColorBlock(color, pattern = 'solid') {
        const hexClean = String(color || '#38bdf8').replace('#', '').toLowerCase();
        const pat = pattern || 'solid';
        const id = `custom_col_${hexClean}_${pat}`;
        if (!this.blocks.has(id)) {
            const def = {
                id,
                name: pat === 'solid' ? `Cubo #${hexClean.toUpperCase()}` : `Cubo ${pat.toUpperCase()} #${hexClean.toUpperCase()}`,
                icon: '🎨',
                category: 'custom',
                mode: pat === 'solid' ? 'solid' : 'voxel',
                color: `#${hexClean}`,
                pattern: pat,
                shaderKind: 'builtin',
                shaderValue: 'plasma_neon',
                emissive: pat === 'crystal'
            };
            this.blocks.set(id, def);
            this.rebuildMaterial(id);
        }
        return this.blocks.get(id);
    }

    /**
     * Obtiene o registra un bloque personalizado a partir de la configuración actual del pincel (Color Sólido o Shader)
     */
    getOrCreateBrushBlock() {
        const b = this.activeBrush;
        if (b.mode === 'shader') {
            return this.getOrCreateShaderBlock(b.shaderKind, b.shaderValue, b.shaderTitle, b.shaderThumb, b.emissive);
        } else {
            const pat = b.mode === 'solid' ? 'solid' : (b.pattern || 'solid');
            return this.getOrCreateColorBlock(b.color, pat);
        }
    }

    /**
     * Actualiza la apariencia (Color Sólido, Textura Voxel o Shader de jpshadereditorInclude)
     * de un bloque existente (por ejemplo Pasto, Piedra, Madera, Hojas en el Creador de Bioma)
     */
    updateBlockAppearance(blockId, changes) {
        const def = this.blocks.get(blockId);
        if (!def) return null;
        Object.assign(def, changes);
        this.rebuildMaterial(blockId);
        return def;
    }

    rebuildMaterial(blockId) {
        const def = this.blocks.get(blockId);
        if (!def) return;

        let mat;
        if (def.mode === 'shader') {
            const entry = this.shaderHub.getOrCreateShaderEntry(def.shaderKind || 'shader', def.shaderValue);
            mat = new THREE.MeshStandardMaterial({
                map: entry.texture,
                roughness: 0.3,
                metalness: 0.08,
                emissive: new THREE.Color(def.emissive !== false ? 0xffffff : 0x555555),
                emissiveMap: entry.texture,
                emissiveIntensity: def.emissive !== false ? 0.72 : 0.30,
                transparent: !!def.transparent,
                opacity: def.opacity || 1.0
            });
            try {
                if (entry.renderedOnce && entry.canvas2d) {
                    this.previewIcons.set(blockId, entry.canvas2d.toDataURL());
                } else {
                    this.previewIcons.set(blockId, this.generateShaderIconDataUrl(def));
                }
            } catch (e) {
                this.previewIcons.set(blockId, this.generateShaderIconDataUrl(def));
            }
        } else if (def.pattern === 'grass' && def.mode === 'voxel') {
            const topTex = this.createPixelTexture('grass_top', def.color);
            const sideTex = this.createPixelTexture('grass_side', def.color, def.secondaryColor || '#79553a');
            const bottomTex = this.createPixelTexture('dirt', def.secondaryColor || '#79553a');

            const sideMat = new THREE.MeshLambertMaterial({ map: sideTex });
            const topMat = new THREE.MeshLambertMaterial({ map: topTex });
            const bottomMat = new THREE.MeshLambertMaterial({ map: bottomTex });
            mat = [sideMat, sideMat, topMat, bottomMat, sideMat, sideMat];
            this.previewIcons.set(blockId, sideTex.image.toDataURL());
        } else if (def.pattern === 'wood' && def.mode === 'voxel') {
            const barkTex = this.createPixelTexture('wood_side', def.color);
            const ringTex = this.createPixelTexture('wood_top', def.secondaryColor || '#b88b5a', def.color);
            const sideMat = new THREE.MeshLambertMaterial({ map: barkTex });
            const topMat = new THREE.MeshLambertMaterial({ map: ringTex });
            mat = [sideMat, sideMat, topMat, topMat, sideMat, sideMat];
            this.previewIcons.set(blockId, barkTex.image.toDataURL());
        } else {
            const patternName = def.mode === 'solid' ? 'solid' : (def.pattern || 'solid');
            const tex = this.createPixelTexture(patternName, def.color, def.secondaryColor);
            mat = new THREE.MeshLambertMaterial({
                map: tex,
                transparent: !!def.transparent,
                opacity: def.opacity || 1.0,
                emissive: def.emissive ? new THREE.Color(def.color) : new THREE.Color(0x000000),
                emissiveIntensity: def.emissive ? 0.35 : 0
            });
            this.previewIcons.set(blockId, tex.image.toDataURL());
        }

        this.materials.set(blockId, mat);
        return mat;
    }

    /**
     * Devuelve el conjunto de claves de shaders ('kind:value') actualmente usados en bloques o en el cielo
     */
    getActiveShaderKeys() {
        const set = new Set();
        for (const def of this.blocks.values()) {
            if (def.mode === 'shader' && def.shaderValue) {
                set.add(`${def.shaderKind || 'shader'}:${def.shaderValue}`);
            }
        }
        if (this.activeBrush.mode === 'shader' && this.activeBrush.shaderValue) {
            set.add(`${this.activeBrush.shaderKind || 'shader'}:${this.activeBrush.shaderValue}`);
        }
        if (this.skyConfig.mode === 'shader' && this.skyConfig.shaderValue) {
            set.add(`${this.skyConfig.shaderKind || 'shader'}:${this.skyConfig.shaderValue}`);
        }
        return set;
    }

    generateShaderIconDataUrl(def) {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 64, 64);
        g.addColorStop(0, '#ec4899');
        g.addColorStop(0.5, '#8b5cf6');
        g.addColorStop(1, '#06b6d4');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('1-BUF', 32, 36);
        return c.toDataURL();
    }

    /**
     * Genera una textura 16x16 escalada a 128x128 con filtro Nearest para estética Voxel impecable
     */
    createPixelTexture(pattern, hexColor, secondaryHex = '#5c4033') {
        const grid = 16;
        const size = 128;
        const scale = size / grid;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const baseRGB = this.hexToRgb(hexColor || '#ffffff');
        const secRGB = this.hexToRgb(secondaryHex || '#79553a');

        let seed = 1337;
        for (let i = 0; i < pattern.length; i++) seed = (seed * 31 + pattern.charCodeAt(i)) & 0x7fffffff;
        const rand = () => {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        };

        for (let y = 0; y < grid; y++) {
            for (let x = 0; x < grid; x++) {
                let r = baseRGB.r, g = baseRGB.g, b = baseRGB.b;
                const isBorder = x === 0 || y === 0 || x === grid - 1 || y === grid - 1;

                if (pattern === 'solid') {
                    if (x === 0 || y === 0) {
                        r = Math.min(255, r + 18);
                        g = Math.min(255, g + 18);
                        b = Math.min(255, b + 18);
                    } else if (x === grid - 1 || y === grid - 1) {
                        r = Math.max(0, r - 22);
                        g = Math.max(0, g - 22);
                        b = Math.max(0, b - 22);
                    }
                } else if (pattern === 'grass_top' || pattern === 'grass') {
                    const n = (rand() - 0.5) * 34;
                    r = this.clamp(r + n * 0.7);
                    g = this.clamp(g + n);
                    b = this.clamp(b + n * 0.6);
                    if (isBorder) { r *= 0.92; g *= 0.92; b *= 0.92; }
                } else if (pattern === 'grass_side') {
                    const grassDepth = 3 + Math.floor(((Math.sin(x * 1.7) + 1) * 1.5) + (rand() * 1.6));
                    if (y < grassDepth) {
                        const n = (rand() - 0.5) * 28;
                        r = this.clamp(baseRGB.r + n * 0.7);
                        g = this.clamp(baseRGB.g + n);
                        b = this.clamp(baseRGB.b + n * 0.6);
                        if (y === grassDepth - 1) { r *= 0.82; g *= 0.82; b *= 0.82; }
                    } else {
                        const n = (rand() - 0.5) * 36;
                        r = this.clamp(secRGB.r + n);
                        g = this.clamp(secRGB.g + n * 0.85);
                        b = this.clamp(secRGB.b + n * 0.7);
                    }
                } else if (pattern === 'dirt' || pattern === 'sand') {
                    const n = (rand() - 0.5) * (pattern === 'sand' ? 24 : 42);
                    r = this.clamp(r + n);
                    g = this.clamp(g + n * 0.9);
                    b = this.clamp(b + n * 0.75);
                } else if (pattern === 'stone') {
                    const n = (rand() - 0.5) * 38;
                    const crack = ((x * 7 + y * 13) % 11 === 0) ? -24 : 0;
                    r = this.clamp(r + n + crack);
                    g = this.clamp(g + n + crack);
                    b = this.clamp(b + n + crack);
                } else if (pattern === 'wood_side' || pattern === 'wood') {
                    const stripe = Math.sin(x * 1.4) * 14 + (rand() - 0.5) * 18;
                    r = this.clamp(r + stripe);
                    g = this.clamp(g + stripe * 0.85);
                    b = this.clamp(b + stripe * 0.7);
                } else if (pattern === 'wood_top') {
                    const dx = x - 7.5, dy = y - 7.5;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (x === 0 || y === 0 || x === 15 || y === 15) {
                        r = secRGB.r; g = secRGB.g; b = secRGB.b;
                    } else {
                        const ring = Math.sin(dist * 2.2) * 16;
                        r = this.clamp(baseRGB.r + ring);
                        g = this.clamp(baseRGB.g + ring * 0.85);
                        b = this.clamp(baseRGB.b + ring * 0.65);
                    }
                } else if (pattern === 'leaves') {
                    const n = (rand() - 0.5) * 52;
                    const darkSpot = rand() < 0.22 ? -28 : 0;
                    r = this.clamp(r + n * 0.6 + darkSpot);
                    g = this.clamp(g + n + darkSpot);
                    b = this.clamp(b + n * 0.6 + darkSpot);
                } else if (pattern === 'water') {
                    const wave = (y % 4 === 0 && (x + y) % 3 === 0) ? 28 : (rand() - 0.5) * 14;
                    r = this.clamp(r + wave);
                    g = this.clamp(g + wave);
                    b = this.clamp(b + wave * 1.1);
                } else if (pattern === 'brick') {
                    const row = Math.floor(y / 4);
                    const offset = (row % 2) * 4;
                    const isMortar = (y % 4 === 0) || ((x + offset) % 8 === 0);
                    if (isMortar) {
                        r = this.clamp(r * 0.65 + 60);
                        g = this.clamp(g * 0.65 + 60);
                        b = this.clamp(b * 0.65 + 60);
                    } else {
                        const n = (rand() - 0.5) * 24;
                        r = this.clamp(r + n);
                        g = this.clamp(g + n * 0.8);
                        b = this.clamp(b + n * 0.8);
                    }
                } else if (pattern === 'crystal') {
                    const diag = Math.abs((x - y)) <= 1 || Math.abs((x + y - 15)) <= 1;
                    const boost = isBorder ? 45 : (diag ? 32 : (rand() - 0.5) * 20);
                    r = this.clamp(r + boost);
                    g = this.clamp(g + boost);
                    b = this.clamp(b + boost);
                }

                ctx.fillStyle = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
                ctx.fillRect(x * scale, y * scale, scale, scale);
            }
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestMipmapLinearFilter;
        texture.needsUpdate = true;
        return texture;
    }

    hexToRgb(hex) {
        const clean = String(hex || '#ffffff').replace('#', '');
        const num = parseInt(clean.length === 3
            ? clean.split('').map(c => c + c).join('')
            : clean, 16) || 0xffffff;
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255
        };
    }

    clamp(v) {
        return Math.max(0, Math.min(255, v));
    }

    serializeConfig() {
        const blockConfigs = {};
        for (const [id, def] of this.blocks.entries()) {
            blockConfigs[id] = { ...def };
        }
        return {
            blocks: blockConfigs,
            skyConfig: { ...this.skyConfig },
            activeBrush: { ...this.activeBrush }
        };
    }

    deserializeConfig(data) {
        if (!data) return;
        if (data.skyConfig) Object.assign(this.skyConfig, data.skyConfig);
        if (data.activeBrush) Object.assign(this.activeBrush, data.activeBrush);
        if (data.blocks) {
            for (const [id, def] of Object.entries(data.blocks)) {
                this.blocks.set(id, { ...def });
                this.rebuildMaterial(id);
            }
        }
    }
}

window.MaterialManager = MaterialManager;
