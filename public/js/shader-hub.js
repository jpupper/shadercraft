/**
 * JPShaderHub — Indexador y Motor de Render de Shaders de 1 Solo Buffer (jpshadereditorInclude)
 * ---------------------------------------------------------------------------------------------
 * - Indexa exclusivamente los Shaders de UN SOLO BUFFER (1 pase) de jpshadereditorInclude
 *   más una colección de Shaders Procedurales 1-Buffer locales sin grillas ni líneas.
 * - Renderiza cada shader activo en tiempo real sobre un THREE.CanvasTexture (256x256)
 *   para aplicar a cualquier cubo, elemento del bioma o cielo 3D.
 * - Compila un shader procedural suave de forma instantánea mientras descarga el plan
 *   remoto para que jamás aparezcan grillas ni placeholders de líneas.
 */
class JPShaderHub {
    constructor() {
        const cfg = window.CONFIG || {};
        this.VPS_BASE = cfg.JPSHADER_VPS || 'https://vps-4455523-x.dattaweb.com/jpshadereditor';
        this.LOCAL_BASE = cfg.JPSHADER_LOCAL || 'http://localhost:3250/jpshadereditor';
        this.base = this.VPS_BASE;
        this.serverStatus = { web: false, local: false, active: 'vps' };

        // Catálogo indexado (estrictamente Shaders de 1 solo buffer)
        this.catalog = {
            shaders: [],
            builtins: this.getBuiltinShaders()
        };
        this.loadingCatalog = false;
        this.catalogLoaded = { shaders: false };
        this.onCatalogListeners = [];
        this.onEntryRenderedListeners = [];

        // Motor WebGL compartido (256x256 para texturas de bloques)
        this.TEX_SIZE = 256;
        this.hubCanvas = document.createElement('canvas');
        this.hubCanvas.width = this.TEX_SIZE;
        this.hubCanvas.height = this.TEX_SIZE;
        this.renderer = null;

        // Mapa de entradas activas: key ("shader:Nombre" | "builtin:id") -> Entry
        this.entries = new Map();

        // Preview en vivo para el selector de shaders
        this.previewEntry = null;
        this.previewTargetCanvas = null;

        this.initRenderer();
        this.detectBestServer();
    }

    initRenderer() {
        if (!window.shaderParser) {
            window.shaderParser = {
                uniforms: new Map(),
                sliders: new Map(),
                getUniformValues: () => ({}),
                clearUniforms: () => {},
                parseShader: () => []
            };
        }
        if (typeof WebGLRenderer === 'function') {
            this.renderer = new WebGLRenderer(
                this.hubCanvas,
                (title, msg) => {
                    if (title || msg) console.warn('[JPShaderHub GL]', title, msg);
                },
                {}
            );
            this.renderer.parameters.screenWidth = this.TEX_SIZE;
            this.renderer.parameters.screenHeight = this.TEX_SIZE;
            this.renderer.parameters.bpm = 120;
            this.renderer.inicializarContexto();
        } else {
            console.error('[JPShaderHub] WebGLRenderer no encontrado.');
        }
    }

    async pingBase(baseUrl) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 2200);
            const res = await fetch(baseUrl + '/api/include/info', {
                cache: 'no-store',
                signal: ctrl.signal
            });
            clearTimeout(timer);
            if (!res.ok) return false;
            const data = await res.json();
            return !!(data && data.ok);
        } catch (e) {
            return false;
        }
    }

    async detectBestServer() {
        const webOk = await this.pingBase(this.VPS_BASE);
        this.serverStatus.web = webOk;

        if (webOk) {
            this.base = this.VPS_BASE;
            this.serverStatus.active = 'vps';
        } else {
            const localOk = await this.pingBase(this.LOCAL_BASE);
            this.serverStatus.local = localOk;
            if (localOk) {
                this.base = this.LOCAL_BASE;
                this.serverStatus.active = 'local';
            }
        }
        this.notifyCatalogListeners();
        this.loadFullCatalog();
    }

    setServerMode(mode) {
        if (mode === 'local') {
            this.base = this.LOCAL_BASE;
            this.serverStatus.active = 'local';
        } else {
            this.base = this.VPS_BASE;
            this.serverStatus.active = 'vps';
        }
        this.catalogLoaded = { shaders: false };
        this.loadFullCatalog();
    }

    onCatalogUpdate(cb) {
        this.onCatalogListeners.push(cb);
    }

    onEntryRendered(cb) {
        this.onEntryRenderedListeners.push(cb);
    }

    notifyCatalogListeners() {
        for (const cb of this.onCatalogListeners) {
            try { cb(this.catalog, this.serverStatus); } catch (e) {}
        }
    }

    notifyEntryRendered(entry) {
        for (const cb of this.onEntryRenderedListeners) {
            try { cb(entry); } catch (e) {}
        }
    }

    async loadFullCatalog() {
        if (this.loadingCatalog) return;
        this.loadingCatalog = true;
        try {
            await this.loadCatalogTab('shaders');
        } finally {
            this.loadingCatalog = false;
            this.notifyCatalogListeners();
        }
    }

    /**
     * Determina si un documento de /api/shaders corresponde a un shader válido de 1 solo buffer
     */
    isSingleBufferShaderDoc(s) {
        if (!s || !s.nombre) return false;
        if (s.compiles === false || s.compilesOk === false) return false;
        const extraPasses = Number(s.passCounter || 0);
        if (extraPasses > 0) return false;
        const totalPases = Number(s.pases || 1);
        if (totalPases > 1) return false;
        if (s.passesData && typeof s.passesData === 'object') {
            const passKeys = Object.keys(s.passesData).filter(k => k !== 'common');
            if (passKeys.length > 1) return false;
        }
        // Excluir plantillas de grillas/login internas que no son shaders generativos de un buffer
        if (/^(fsc-plantilla-|volumetric-login-fondo|fullscreenhandcode|fullscreencode-fondo)/i.test(String(s.nombre).trim())) {
            return false;
        }
        return true;
    }

    async loadCatalogTab(tab) {
        if (tab !== 'shaders' || this.catalogLoaded.shaders) return;
        try {
            const res = await fetch(this.base + '/api/shaders');
            const data = await res.json();
            const rawArr = Array.isArray(data) ? data : (data && Array.isArray(data.shaders) ? data.shaders : []);

            // Filtrar estrictamente shaders de UN SOLO BUFFER que compilan bien
            const filtered = rawArr.filter(s => this.isSingleBufferShaderDoc(s));
            filtered.sort((a, b) => new Date(b.fechaActualizacion || 0) - new Date(a.fechaActualizacion || 0));

            this.catalog.shaders = filtered.map(s => ({
                kind: 'shader',
                value: String(s.nombre).trim(),
                title: String(s.nombre).trim(),
                author: s.autor || 'anónimo',
                sub: [s.autor || 'GLSL', '1 Buffer'].filter(Boolean).join(' · '),
                thumb: s.imagePath || '',
                updatedAt: s.fechaActualizacion
            }));

            this.catalogLoaded.shaders = true;
            this.notifyCatalogListeners();
        } catch (err) {
            console.warn('[JPShaderHub] No se pudo cargar catálogo de shaders:', err);
        }
    }

    /**
     * Crea o recupera una textura animada THREE.CanvasTexture para un shader de 1 solo buffer
     */
    getOrCreateShaderEntry(kind, value) {
        const cleanKind = (kind === 'builtin') ? 'builtin' : 'shader';
        const cleanValue = String(value || 'plasma_neon').trim();
        const key = `${cleanKind}:${cleanValue}`;

        if (this.entries.has(key)) {
            return this.entries.get(key);
        }

        const canvas2d = document.createElement('canvas');
        canvas2d.width = this.TEX_SIZE;
        canvas2d.height = this.TEX_SIZE;
        const ctx2d = canvas2d.getContext('2d');

        // Relleno inicial suave (sin ninguna línea ni grilla)
        this.drawSmoothInitialFill(ctx2d, cleanValue);

        const texture = new THREE.CanvasTexture(canvas2d);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.magFilter = THREE.LinearFilter;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

        const entry = {
            key,
            kind: cleanKind,
            value: cleanValue,
            namespace: key.replace(/[^a-zA-Z0-9_]/g, '_') + '__',
            canvas2d,
            ctx2d,
            texture,
            status: 'loading',
            error: null,
            plan: null,
            prefixedOrder: [],
            prefixedDisplayPassId: '',
            uniforms: {},
            iconCaptured: false,
            lastRenderTime: 0
        };

        this.entries.set(key, entry);

        // Compilar de inmediato el plan temporal 1-buffer para que desde el primer frame
        // ya tenga animación orgánica fluida (cero líneas) mientras llega el plan del servidor
        const instantPlan = this.createProceduralFallbackPlan(cleanValue);
        this.compileSingleBufferPlan(entry, instantPlan, false);

        // Cargar y compilar el shader real
        this.loadAndCompileEntry(entry);
        return entry;
    }

    drawSmoothInitialFill(ctx, seedName) {
        const w = this.TEX_SIZE;
        const h = this.TEX_SIZE;
        let hash = 0;
        const str = String(seedName || 'shader');
        for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) & 0xffffff;
        const hue1 = hash % 360;
        const hue2 = (hue1 + 75) % 360;
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, `hsl(${hue1}, 75%, 45%)`);
        grad.addColorStop(1, `hsl(${hue2}, 80%, 35%)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
    }

    /**
     * Limpia declaraciones de arrays gigantes de punteros si el código del shader no los usa
     * y asegura compatibilidad con gl_FragColor opaco (alpha = 1.0) para texturas de cubos 3D.
     */
    sanitizeSingleBufferSource(rawSource) {
        let src = String(rawSource || '');

        // Dividir entre el header inyectado y el cuerpo del shader si es posible
        const bodyPart = src.slice(src.indexOf('#define texture texture2D') + 25);

        if (!/\bpointers\b/.test(bodyPart)) {
            src = src.replace(/uniform\s+vec4\s+pointers\s*\[\s*\d+\s*\]\s*;/g, '');
        }
        if (!/\blidarPointers\b/.test(bodyPart)) {
            src = src.replace(/uniform\s+vec4\s+lidarPointers\s*\[\s*\d+\s*\]\s*;/g, '');
        }
        if (!/\bsimulatedPointers\b/.test(bodyPart)) {
            src = src.replace(/uniform\s+vec4\s+simulatedPointers\s*\[\s*\d+\s*\]\s*;/g, '');
        }

        return src;
    }

    async loadAndCompileEntry(entry) {
        try {
            let plan = null;
            if (entry.kind === 'builtin') {
                const b = this.catalog.builtins.find(x => x.value === entry.value) || this.catalog.builtins[0];
                plan = {
                    ok: true,
                    fuente: 'builtin',
                    label: b.title,
                    order: ['main'],
                    displayPassId: 'main',
                    passes: [{
                        id: 'main',
                        name: 'main',
                        source: b.source,
                        inputs: [null, null, null, null],
                        uniforms: b.uniforms || {}
                    }]
                };
            } else {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 8000);
                const param = `shader=${encodeURIComponent(entry.value)}`;
                const url = `${this.base}/api/include/plan?${param}&_=${Date.now()}`;
                const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
                clearTimeout(timer);
                plan = await res.json();
            }

            if (!plan || plan.ok === false || !Array.isArray(plan.passes) || !plan.passes.length) {
                throw new Error((plan && plan.error) || 'Plan de shader vacío o inválido');
            }

            // Asegurar estrictamente UN SOLO BUFFER (tomar el pase principal/display)
            let mainPass = plan.passes[0];
            if (plan.passes.length > 1) {
                mainPass = plan.passes.find(p => p.id === plan.displayPassId || p.id === 'main')
                    || plan.passes[plan.passes.length - 1];
            }

            // Limpiar cualquier entrada que apunte a otro buffer multipase
            const cleanInputs = (mainPass.inputs || [null, null, null, null]).map(inp => {
                if (!inp) return null;
                if (inp.type === 'buffer' || inp.type === 'self') return null;
                return inp;
            });

            const singleBufferPlan = {
                ok: true,
                fuente: plan.fuente || 'shader',
                label: plan.label || entry.value,
                order: ['main'],
                displayPassId: 'main',
                passes: [{
                    id: 'main',
                    name: 'main',
                    source: this.sanitizeSingleBufferSource(mainPass.source),
                    inputs: cleanInputs,
                    aliases: mainPass.aliases || {},
                    uniforms: mainPass.uniforms || {}
                }]
            };

            const compiledOk = this.compileSingleBufferPlan(entry, singleBufferPlan, true);
            if (!compiledOk) {
                throw new Error('El shader no pudo compilar en WebGL1');
            }
        } catch (err) {
            console.warn(`[JPShaderHub] Usando shader generativo de respaldo para ${entry.key}:`, err.message || err);
            entry.error = err.message || String(err);
            const fallback = this.createProceduralFallbackPlan(entry.value);
            this.compileSingleBufferPlan(entry, fallback, true);
        }
    }

    compileSingleBufferPlan(entry, plan, isFinal = true) {
        if (!this.renderer || !this.renderer.gl) return false;
        const r = this.renderer;
        const ns = entry.namespace;

        // Guardar copia de passOrder actual antes de addPass para que ningún otro entry se vea afectado
        const prevOrder = Array.isArray(r.passOrder) ? r.passOrder.slice() : [];

        // Limpiar pase anterior de este entry si existía
        for (const pid of entry.prefixedOrder) {
            r.removePass(pid);
        }

        // Vertex shader compatible tanto con gl_FragCoord como con surfacePosition (GLSL Sandbox)
        const vertexSrc = [
            'attribute vec3 position;',
            'varying vec2 surfacePosition;',
            'void main() {',
            '    surfacePosition = position.xy * 0.5;',
            '    gl_Position = vec4(position, 1.0);',
            '}'
        ].join('\n');

        const p = plan.passes[0];
        const pid = ns + 'main';

        const pass = r.addPass(pid, p.name || 'main', 'buffer', {
            iteraciones: 1,
            escala: 1
        });
        pass.inputAliases = p.aliases || {};

        const prog = r.compilePass(pid, p.source, vertexSrc, null);
        if (!prog) {
            r.removePass(pid);
            r.passOrder = prevOrder;
            return false;
        }

        // Configurar texturas de imagen de entrada (si el shader usa iChannel0..3 con imagen)
        for (let i = 0; i < 4; i++) {
            const inp = (p.inputs || [])[i];
            if (!inp) {
                pass.inputs[i] = null;
                continue;
            }
            if (inp.type === 'texture_url' && !/^[a-z][a-z0-9+.-]*:/i.test(inp.id)) {
                pass.inputs[i] = {
                    type: 'texture_url',
                    id: this.base + '/' + String(inp.id).replace(/^\/+/, '')
                };
            } else if (inp.type === 'texture_url') {
                pass.inputs[i] = { ...inp };
            } else {
                pass.inputs[i] = null;
            }
        }

        // Indexar y subir uniforms propios del shader
        entry.uniforms = {};
        const pUniforms = p.uniforms || {};
        for (const uName of Object.keys(pUniforms)) {
            const val = pUniforms[uName];
            r.setPassUniform(pid, uName, val);
            if (!this.isGlobalUniform(uName)) {
                entry.uniforms[uName] = {
                    name: uName,
                    value: val,
                    defaultValue: Array.isArray(val) ? [...val] : val,
                    passIds: [pid]
                };
            }
        }

        entry.prefixedOrder = [pid];
        entry.prefixedDisplayPassId = pid;
        entry.plan = plan;
        entry.status = 'ready';
        entry.iconCaptured = false;

        // Renderizar primer frame inmediatamente y actualizar ícono
        this.renderSingleEntry(entry, isFinal);
        if (isFinal) {
            this.notifyCatalogListeners();
        }
        return true;
    }

    isGlobalUniform(n) {
        return /^(time|resolution|mouse|iTime|iMouse|iResolution|iFrame|iChannelTime|fxrand|fxrnd|BPM|bpm|pointers|pointersCount|pointerCount|simPointerCount|simulatedPointers|simulatedPointersCount|lidarPointers|lidarPointersCount|backbuffer|frame|date|sampleRate|iChannel\d|imageInput\d?)$/.test(n);
    }

    setEntryUniform(key, uniformName, value) {
        const entry = this.entries.get(key);
        if (!entry || !this.renderer) return;
        if (entry.uniforms[uniformName]) {
            entry.uniforms[uniformName].value = value;
            for (const pid of entry.uniforms[uniformName].passIds) {
                this.renderer.setPassUniform(pid, uniformName, value);
            }
        }
    }

    resetEntryUniforms(key) {
        const entry = this.entries.get(key);
        if (!entry) return;
        for (const uName of Object.keys(entry.uniforms)) {
            const def = entry.uniforms[uName].defaultValue;
            const copy = Array.isArray(def) ? [...def] : def;
            this.setEntryUniform(key, uName, copy);
        }
    }

    renderSingleEntry(entry, captureIcon = false) {
        if (!this.renderer || entry.status !== 'ready' || !entry.prefixedOrder.length) return;
        const r = this.renderer;

        // IMPORTANTE: pasar una COPIA (.slice()) de prefixedOrder para que addPass nunca mute el array del entry
        r.passOrder = entry.prefixedOrder.slice();
        r.displayPassId = entry.prefixedDisplayPassId;
        r.render(null);

        // Fondo opaco de respaldo y copia del canvas WebGL al canvas 2D de la textura Three.js
        entry.ctx2d.fillStyle = '#0f172a';
        entry.ctx2d.fillRect(0, 0, this.TEX_SIZE, this.TEX_SIZE);
        entry.ctx2d.drawImage(this.hubCanvas, 0, 0, this.TEX_SIZE, this.TEX_SIZE);
        entry.texture.needsUpdate = true;

        if (captureIcon && !entry.iconCaptured) {
            entry.iconCaptured = true;
            this.notifyEntryRendered(entry);
        }
    }

    /**
     * Llamado en cada frame del loop principal del juego para actualizar las texturas de los shaders activos
     */
    updateActiveShaders(activeKeysSet) {
        if (!this.renderer) return;
        for (const [key, entry] of this.entries.entries()) {
            if (entry.status !== 'ready') continue;
            if (activeKeysSet && !activeKeysSet.has(key) && this.previewEntry !== entry) continue;
            this.renderSingleEntry(entry, !entry.iconCaptured);
        }

        if (this.previewEntry && this.previewTargetCanvas && this.previewEntry.status === 'ready') {
            const pCtx = this.previewTargetCanvas.getContext('2d');
            if (pCtx) {
                pCtx.drawImage(
                    this.previewEntry.canvas2d,
                    0,
                    0,
                    this.previewTargetCanvas.width,
                    this.previewTargetCanvas.height
                );
            }
        }
    }

    startPreview(kind, value, targetCanvas) {
        this.previewEntry = this.getOrCreateShaderEntry(kind, value);
        this.previewTargetCanvas = targetCanvas;
    }

    stopPreview() {
        this.previewEntry = null;
        this.previewTargetCanvas = null;
    }

    createProceduralFallbackPlan(seedName = 'shader') {
        let h = 0;
        const s = String(seedName || 'shader');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
        const r1 = ((h & 0xff) / 255).toFixed(2);
        const g1 = (((h >> 4) & 0xff) / 255).toFixed(2);
        const b1 = (((h >> 8) & 0xff) / 255).toFixed(2);

        return {
            ok: true,
            fuente: 'fallback',
            label: s,
            order: ['main'],
            displayPassId: 'main',
            passes: [{
                id: 'main',
                name: 'main',
                inputs: [null, null, null, null],
                uniforms: { speed: 0.5, scale: 0.5 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float speed;
                    uniform float scale;
                    void main() {
                        vec2 uv = gl_FragCoord.xy / resolution.xy;
                        float t = time * (0.6 + speed * 1.4);
                        vec2 p = (uv - 0.5) * (2.5 + scale * 4.5);
                        float v = sin(p.x + t) + cos(p.y - t * 0.8) + sin(length(p) * 2.0 - t * 1.2);
                        vec3 col = 0.52 + 0.48 * cos(v * 1.4 + vec3(${r1}, ${g1}, ${b1}) * 6.2831 + t * 0.5);
                        gl_FragColor = vec4(col, 1.0);
                    }
                `
            }]
        };
    }

    /**
     * Colección de 8 Shaders de 1 solo buffer integrados (100% orgánicos, sin grillas ni líneas)
     */
    getBuiltinShaders() {
        return [
            {
                kind: 'builtin',
                value: 'plasma_neon',
                title: 'Ondas de Plasma Solar',
                author: '1-Buffer Built-in',
                sub: 'Plasma Orgánico · 1 Buffer',
                thumb: '',
                uniforms: { u_speed: 0.5, u_zoom: 0.5 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_speed;
                    uniform float u_zoom;
                    void main() {
                        vec2 uv = (gl_FragCoord.xy - 0.5 * resolution.xy) / resolution.y;
                        float t = time * (0.5 + u_speed * 1.4);
                        vec2 p = uv * (2.2 + u_zoom * 3.5);
                        float a = sin(p.x * 2.1 + t) + cos(p.y * 2.4 - t * 0.8);
                        float b = sin(length(p) * 3.2 - t * 1.3) + cos((p.x + p.y) * 1.8 + t);
                        vec3 col = 0.5 + 0.5 * cos(vec3(0.1, 0.45, 0.82) * 6.2831 + (a + b) * 1.15 + t * 0.4);
                        gl_FragColor = vec4(col, 1.0);
                    }
                `
            },
            {
                kind: 'builtin',
                value: 'lava_magma',
                title: 'Magma Volcánico Fluido',
                author: '1-Buffer Built-in',
                sub: 'Lava Incandescente · 1 Buffer',
                thumb: '',
                uniforms: { u_heat: 0.65, u_scale: 0.5 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_heat;
                    uniform float u_scale;
                    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                    float noise(vec2 p) {
                        vec2 i = floor(p), f = fract(p);
                        f = f * f * (3.0 - 2.0 * f);
                        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
                    }
                    float fbm(vec2 p) {
                        float v = 0.0, a = 0.5;
                        for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
                        return v;
                    }
                    void main() {
                        vec2 uv = gl_FragCoord.xy / resolution.xy;
                        float s = 2.8 + u_scale * 5.0;
                        vec2 q = vec2(fbm(uv * s + time * 0.25), fbm(uv * s + vec2(5.2, 1.3) - time * 0.2));
                        float f = fbm(uv * s + q * 2.5 + time * 0.15);
                        vec3 darkRock = vec3(0.16, 0.04, 0.02);
                        vec3 redLava = vec3(0.95, 0.22, 0.03);
                        vec3 brightYellow = vec3(1.0, 0.90, 0.28);
                        float glow = smoothstep(0.22, 0.78, f + (u_heat - 0.5) * 0.4);
                        vec3 col = mix(darkRock, redLava, smoothstep(0.18, 0.58, glow));
                        col = mix(col, brightYellow, smoothstep(0.60, 0.92, glow));
                        gl_FragColor = vec4(col, 1.0);
                    }
                `
            },
            {
                kind: 'builtin',
                value: 'water_caustics',
                title: 'Agua Cristalina Caustics',
                author: '1-Buffer Built-in',
                sub: 'Océano & Ríos · 1 Buffer',
                thumb: '',
                uniforms: { u_wave: 0.5, u_foam: 0.5 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_wave;
                    uniform float u_foam;
                    void main() {
                        vec2 uv = gl_FragCoord.xy / resolution.xy;
                        vec2 p = uv * 6.28318 - 250.0;
                        vec2 i = p;
                        float c = 1.0;
                        float inten = 0.005;
                        float t = time * (0.4 + u_wave * 0.8);
                        for (int n = 0; n < 4; n++) {
                            float t2 = t * (1.0 - (3.5 / float(n + 1)));
                            i = p + vec2(cos(t2 - i.x) + sin(t2 + i.y), sin(t2 - i.y) + cos(t2 + i.x));
                            c += 1.0 / length(vec2(p.x / (sin(i.x + t2) / inten), p.y / (cos(i.y + t2) / inten)));
                        }
                        c /= 4.0;
                        c = 1.17 - pow(c, 1.4);
                        vec3 colour = vec3(pow(abs(c), 8.0 * (0.6 + u_foam * 0.8)));
                        colour = clamp(colour + vec3(0.04, 0.46, 0.74), 0.0, 1.0);
                        gl_FragColor = vec4(colour, 1.0);
                    }
                `
            },
            {
                kind: 'builtin',
                value: 'bio_forest',
                title: 'Musgo Bioluminiscente',
                author: '1-Buffer Built-in',
                sub: 'Pasto Vivo Orgánico · 1 Buffer',
                thumb: '',
                uniforms: { u_pulse: 0.5, u_density: 0.5 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_pulse;
                    uniform float u_density;
                    float hash(vec2 p) { return fract(sin(dot(p, vec2(41.1, 289.7))) * 45758.5453); }
                    float noise(vec2 p) {
                        vec2 i = floor(p), f = fract(p);
                        f = f * f * (3.0 - 2.0 * f);
                        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
                    }
                    void main() {
                        vec2 uv = gl_FragCoord.xy / resolution.xy;
                        float s = 4.0 + u_density * 6.0;
                        float n1 = noise(uv * s + vec2(time * 0.2, -time * 0.15));
                        float n2 = noise(uv * s * 2.1 - vec2(time * 0.18, time * 0.22));
                        float blend = 0.5 * (n1 + n2);
                        float pulse = 0.5 + 0.5 * sin(time * (1.2 + u_pulse * 2.5) + blend * 6.28);
                        vec3 deepMoss = vec3(0.09, 0.42, 0.16);
                        vec3 lushGreen = vec3(0.28, 0.78, 0.32);
                        vec3 bioGlow = vec3(0.25, 0.98, 0.68);
                        vec3 col = mix(deepMoss, lushGreen, smoothstep(0.2, 0.75, blend));
                        col = mix(col, bioGlow, smoothstep(0.65, 0.95, blend * pulse));
                        gl_FragColor = vec4(col, 1.0);
                    }
                `
            },
            {
                kind: 'builtin',
                value: 'cyber_grid',
                title: 'Nebulosa Amatista',
                author: '1-Buffer Built-in',
                sub: 'Cristal Cósmico · 1 Buffer',
                thumb: '',
                uniforms: { u_hue: 0.5, u_glow: 0.6 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_hue;
                    uniform float u_glow;
                    void main() {
                        vec2 uv = (gl_FragCoord.xy - 0.5 * resolution.xy) / resolution.y;
                        float t = time * 0.55;
                        vec2 p = uv * 2.6;
                        for (int i = 1; i < 4; i++) {
                            float fi = float(i);
                            p.x += 0.35 / fi * sin(fi * 2.5 * p.y + t);
                            p.y += 0.35 / fi * cos(fi * 2.5 * p.x + t * 0.9);
                        }
                        vec3 col = 0.5 + 0.5 * cos((u_hue * 6.28) + p.xyx * 1.4 + vec3(0.0, 2.1, 4.2));
                        col *= 0.75 + 0.45 * u_glow;
                        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
                    }
                `
            },
            {
                kind: 'builtin',
                value: 'portal_vortex',
                title: 'Portal Vórtice Dimensional',
                author: '1-Buffer Built-in',
                sub: 'Vórtice Espiral · 1 Buffer',
                thumb: '',
                uniforms: { u_twist: 0.6, u_speed: 0.5 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_twist;
                    uniform float u_speed;
                    void main() {
                        vec2 uv = (gl_FragCoord.xy - 0.5 * resolution.xy) / resolution.y;
                        float r = length(uv);
                        float a = atan(uv.y, uv.x);
                        float t = time * (0.8 + u_speed * 2.0);
                        float s = sin(a * 4.0 + r * (8.0 + u_twist * 14.0) - t * 2.5);
                        float s2 = cos(a * 3.0 - r * 10.0 + t * 1.8);
                        vec3 c1 = vec3(0.45, 0.08, 0.88);
                        vec3 c2 = vec3(0.95, 0.32, 1.0);
                        vec3 c3 = vec3(0.10, 0.02, 0.24);
                        vec3 col = mix(c3, c1, smoothstep(-0.6, 0.4, s));
                        col = mix(col, c2, smoothstep(0.25, 0.92, s * s2));
                        gl_FragColor = vec4(col, 1.0);
                    }
                `
            },
            {
                kind: 'builtin',
                value: 'runic_stone',
                title: 'Mármol Mineral Rúnico',
                author: '1-Buffer Built-in',
                sub: 'Roca Energética · 1 Buffer',
                thumb: '',
                uniforms: { u_energy: 0.6 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_energy;
                    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                    float noise(vec2 p) {
                        vec2 i = floor(p), f = fract(p);
                        f = f * f * (3.0 - 2.0 * f);
                        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
                    }
                    void main() {
                        vec2 uv = gl_FragCoord.xy / resolution.xy;
                        float n = noise(uv * 5.0) * 0.6 + noise(uv * 11.0) * 0.4;
                        float swirl = sin(uv.x * 7.0 + n * 5.5 + time * 0.7);
                        vec3 baseRock = mix(vec3(0.26, 0.30, 0.36), vec3(0.46, 0.52, 0.58), n);
                        vec3 veinCol = vec3(0.15, 0.85, 1.0) * (0.5 + u_energy * 0.8);
                        float glow = smoothstep(0.72, 0.98, abs(swirl));
                        gl_FragColor = vec4(mix(baseRock, veinCol, glow * 0.75), 1.0);
                    }
                `
            },
            {
                kind: 'builtin',
                value: 'sunset_sky_aurora',
                title: 'Aurora Boreal Cósmica',
                author: '1-Buffer Built-in',
                sub: 'Cielo & Cristal · 1 Buffer',
                thumb: '',
                uniforms: { u_aurora: 0.7 },
                source: `
                    precision mediump float;
                    uniform float time;
                    uniform vec2 resolution;
                    uniform float u_aurora;
                    void main() {
                        vec2 uv = gl_FragCoord.xy / resolution.xy;
                        vec3 sky = mix(vec3(0.09, 0.05, 0.22), vec3(0.02, 0.03, 0.09), uv.y);
                        float wave = sin(uv.x * 7.0 + time * 0.7) * 0.12 + sin(uv.x * 13.0 - time * 1.1) * 0.05;
                        float band = exp(-abs(uv.y - 0.55 - wave) * 7.0) * (0.5 + u_aurora);
                        vec3 aur = mix(vec3(0.1, 0.95, 0.55), vec3(0.65, 0.2, 0.98), uv.x);
                        gl_FragColor = vec4(sky + aur * band, 1.0);
                    }
                `
            }
        ];
    }
}

window.jpShaderHub = new JPShaderHub();
