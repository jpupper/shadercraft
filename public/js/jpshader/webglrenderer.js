/**
 * WebGLRenderer - Clase para manejar toda la funcionalidad de renderizado WebGL
 * Encapsula la inicialización, compilación y renderizado de shaders
 * Ahora soporta múltiples pases (buffers) al estilo Shadertoy
 */
class WebGLRenderer {
    constructor(canvasElement, errorCallback, loadingCallbacks) {
        this.canvas = canvasElement;
        this.gl = null;
        this.commonBuffer = null;

        // Pases (Buffers)
        this.passes = new Map(); // id -> Pass object
        this.passOrder = []; // Array de IDs en orden de ejecución

        // Texturas de entrada globales (imágenes cargadas)
        this.inputTextures = [null, null, null];
        this.blankTexture = null;

        // Parámetros de renderizado
        this.parameters = {
            startTime: Date.now(),
            time: 0,
            mouse: [0, 0, 0, 0], // x, y, z, w (Shadertoy style)
            screenWidth: 0,
            screenHeight: 0,
            fxrand: Math.random(),
            iFrame: 0,
            bpm: 120, // Global BPM support
            pointers: [], // Array of {x, y} from all connected clients (only while pressed)
            // Puntos del LIDAR: GLOBALES (los reparte el servidor a TODOS los shaders).
            // Cualquier shader los lee con `lidarPointers[]` + `lidarPointersCount`
            // (los declara el header si el shader no los declara él mismo).
            lidarPointers: []
        };

        // Callbacks
        this.onError = errorCallback || ((title, msg) => console.error(title, msg));
        this.showLoading = loadingCallbacks?.showLoading || (() => { });
        this.hideLoading = loadingCallbacks?.hideLoading || (() => { });

        this.hideOnNextFrame = false;
        this.lastShaderError = '';
        this.isFullscreen = false;
        this.displayPassId = 'main'; // ID del pase que se muestra en pantalla

        // ENTRADAS DE MEDIOS (cámara / depthmap / openpose): NO se activan solas.
        // El host que SÍ debe levantarlas (editor, nodeeditor, engine del include)
        // pone `renderer.mediaInputsActivos = true`. Los previews por hover
        // (MiniShaderPreview / panel del include) lo dejan en false a propósito:
        // si no, pasar el mouse por un shader que usa modelos dispararía descargas.
        this.mediaInputsActivos = false;
    }

    /**
     * Inicializa el contexto WebGL
     */
    inicializarContexto() {
        try {
            this.gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false }) || this.canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
            if (this.gl) {
                this.inicializarWebGL();
                return true;
            }
            return false;
        } catch (error) {
            console.error("Error al inicializar WebGL:", error);
            return false;
        }
    }

    /**
     * Inicializa WebGL básico
     */
    inicializarWebGL() {
        try {
            const gl = this.gl;
            if (!gl) return false;

            // Habilitar blending para transparencias
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            // Crear buffer de vértices común (quad que cubre la pantalla)
            this.commonBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.commonBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1.0, -1.0,
                1.0, -1.0,
                -1.0, 1.0,
                1.0, -1.0,
                1.0, 1.0,
                -1.0, 1.0
            ]), gl.STATIC_DRAW);

            this.blankTexture = this.createBlankTexture();
            
            // Habilitar extensiones de punto flotante para simulaciones (Wyatt fluid, etc)
            this.floatTextureExt = gl.getExtension('OES_texture_float');
            this.floatLinearExt = gl.getExtension('OES_texture_float_linear');
            
            return true;
        } catch (error) {
            console.error('Error al inicializar WebGL:', error);
            return false;
        }
    }

    /**
     * Añade un nuevo pase (Buffer)
     */
    addPass(id, name, type = 'buffer', opciones = {}) {
        const pass = {
            id: id,
            name: name,
            type: type, // 'buffer' o 'image'
            code: '',
            program: null,
            // ITERACIONES POR PASE: cuántas veces se dibuja este pase en CADA frame.
            // Es lo que permite portar solvers iterativos (presión del fluido: ~20
            // Jacobi por frame) sin necesitar 20 buffers distintos: es el MISMO pase
            // dibujado N veces, con ping-pong entre sus dos render targets.
            // 1 = comportamiento de siempre.
            iterations: this._normalizarIteraciones(opciones.iterations !== undefined ? opciones.iterations : opciones.iteraciones),
            // ESCALA DEL PASE: 1 = tamaño del canvas · 0.5 = mitad por lado (1/4
            // de píxeles). Sirve para resolver simulaciones a baja resolución.
            scale: this._normalizarEscala(opciones.escala !== undefined ? opciones.escala : opciones.scale),
            renderTargets: [null, null], // Ping-pong targets
            currentFront: 0,
            inputs: [null, null, null, null], // 4 slots: { type: 'buffer'|'texture', id: string|index }
            uniformsCache: {},
            // NODEEDITOR: samplers propios del shader (tex0, inputImage, …) aliasados
            // al texture unit del inlet conectado, así cualquier shader recibe su entrada.
            inputAliases: {},
            // Sistema de nodos: valores de uniforms PROPIOS de este pase. Si el pase
            // los tiene, mandan sobre el mapa global del shaderParser (cada pase
            // tiene su propio programa, así que dos nodos pueden usar el mismo
            // nombre de uniform con valores distintos, igual que las cajas de Guipper).
            uniformValues: {}
        };

        if (type === 'buffer' || type === 'image') {
            const filter = (id === 'buffer2' || id === 'buffer3') ? 'NEAREST' : 'LINEAR';
            pass.renderTargets[0] = this.createTarget(this.parameters.screenWidth, this.parameters.screenHeight, filter);
            pass.renderTargets[1] = this.createTarget(this.parameters.screenWidth, this.parameters.screenHeight, filter);
        }

        this.passes.set(id, pass);
        if (type === 'image') {
            this.passOrder.push(id);
        } else {
            // Find the position of the first image pass to insert buffers before it
            const firstImageIdx = this.passOrder.findIndex(pId => this.passes.get(pId).type === 'image');
            if (firstImageIdx === -1) {
                this.passOrder.push(id);
            } else {
                this.passOrder.splice(firstImageIdx, 0, id);
            }
        }
        return pass;
    }

    /**
     * Normaliza el pedido de iteraciones: entero, 1..64.
     * 0/undefined/NaN → 1 (comportamiento de siempre).
     */
    _normalizarIteraciones(n) {
        const v = Math.floor(Number(n));
        if (!isFinite(v) || v < 1) return 1;
        return Math.min(64, v);
    }

    /**
     * Cambia las iteraciones de un pase ya creado (1..64).
     * Se puede llamar en caliente: el próximo frame ya las aplica.
     */
    setPassIterations(id, n) {
        const pass = this.passes.get(id);
        if (!pass) return false;
        pass.iterations = this._normalizarIteraciones(n);
        return true;
    }

    /**
     * Escala del pase: 0.1..1 (1 = canvas). Menos escala = menos píxeles =
     * simulación más barata (fluido a 128/256 px). En caliente: el target se
     * rearma solo en el próximo frame.
     */
    _normalizarEscala(s) {
        const v = Number(s);
        if (!isFinite(v) || v <= 0) return 1;
        return Math.min(1, Math.max(0.05, v));
    }

    setPassScale(id, s) {
        const pass = this.passes.get(id);
        if (!pass) return false;
        pass.scale = this._normalizarEscala(s);
        return true;
    }

    /**
     * Sistema de nodos: setea el valor de un uniform PROPIO de un pase.
     * Cada pase tiene su propio programa GL, así que dos nodos pueden declarar el
     * mismo uniform con valores distintos (equivalente a los parámetros por caja
     * de Guipper). El valor se aplica en render() con prioridad sobre el mapa
     * global del shaderParser.
     */
    setPassUniform(passId, name, value) {
        const pass = this.passes.get(passId);
        if (!pass) return false;
        if (!pass.uniformValues) pass.uniformValues = {};
        let v = value;
        if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) v = v.value;
        // ARRAYS: vec2/vec3/vec4 (el valor canónico de un vector es un array).
        if (v && (Array.isArray(v) || (typeof v === 'object' && typeof v.length === 'number'))) {
            pass.uniformValues[name] = Array.prototype.slice.call(v).map(Number);
            return true;
        }
        const n = Number(v);
        pass.uniformValues[name] = Number.isFinite(n) ? n : 0;
        return true;
    }

    getPassUniform(passId, name) {
        const pass = this.passes.get(passId);
        return pass && pass.uniformValues ? pass.uniformValues[name] : undefined;
    }

    /**
     * Elimina un pase
     */
    removePass(id) {
        const pass = this.passes.get(id);
        if (!pass) return;

        const gl = this.gl;
        if (pass.program) gl.deleteProgram(pass.program);
        pass.renderTargets.forEach(t => {
            if (t) {
                gl.deleteFramebuffer(t.framebuffer);
                gl.deleteTexture(t.texture);
            }
        });

        this.passes.delete(id);
        this.passOrder = this.passOrder.filter(pId => pId !== id);
    }

    /**
     * Configura una conexión de entrada para un pase
     */
    setPassInput(passId, slot, inputType, inputId) {
        const pass = this.passes.get(passId);
        if (!pass || slot < 0 || slot > 3) return;

        pass.inputs[slot] = { type: inputType, id: inputId };
    }

    /**
     * Crea un render target (framebuffer + texture)
     */
    createTarget(width, height, filterType = 'LINEAR') {
        const gl = this.gl;
        let target = {};

        // OJO: un attachment de 0x0 da "framebuffer incompleto" y WebGL tira
        // GL_INVALID_FRAMEBUFFER_OPERATION en CADA glDrawArrays (el error que
        // llenaba la consola). Pasa cuando el target se crea antes de conocer el
        // tamaño real: `parameters.screenWidth` arranca en 0 en un renderer recién
        // creado (típico en los previews del panel del include, que hacen addPass()
        // antes de fijar el tamaño). Se sanea acá y, en render(), el target se
        // rearma solo cuando el tamaño real aparece.
        const w = Math.max(1, Math.floor(Number(width) || 0));
        const h = Math.max(1, Math.floor(Number(height) || 0));
        target.width = w;
        target.height = h;
        target.framebuffer = gl.createFramebuffer();
        target.texture = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        
        // Intentar usar texturas de punto flotante si la extensión está disponible
        let type = gl.UNSIGNED_BYTE;
        if (this.floatTextureExt) {
            type = gl.FLOAT;
        }

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, type, null);

        const filter = (filterType === 'NEAREST') ? gl.NEAREST : gl.LINEAR;
        
        // Si usamos FLOAT y LINEAR, necesitamos la extensión float_linear
        let actualFilter = filter;
        if (type === gl.FLOAT && filter === gl.LINEAR && !this.floatLinearExt) {
            actualFilter = gl.NEAREST; // Fallback a nearest si no hay linear float
        }

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, actualFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, actualFilter);

        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);

        // El estado se consulta UNA vez (no por frame) y queda cacheado: render()
        // saltea los pases con target incompleto en vez de dibujar y comer el error.
        target.completo = (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);

        // Si FLOAT no es color-renderable en esta GPU (falta WEBGL_color_buffer_float),
        // caer automáticamente a UNSIGNED_BYTE para que el FBO sea 100% completo siempre.
        if (!target.completo && type === gl.FLOAT) {
            gl.bindTexture(gl.TEXTURE_2D, target.texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
            target.completo = (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);
        }

        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return target;
    }

    /**
     * Reemplaza un render target por uno nuevo del tamaño pedido (borra el viejo).
     */
    reemplazarTarget(target, width, height, filterType = 'LINEAR') {
        const gl = this.gl;
        if (target) {
            gl.deleteFramebuffer(target.framebuffer);
            gl.deleteTexture(target.texture);
        }
        return this.createTarget(width, height, filterType);
    }

    /**
     * Compila el shader de un pase específico
     */
    compilePass(passId, fragmentSource, vertexSource, shaderParser) {
        const pass = this.passes.get(passId);
        if (!pass) return null;

        this.showLoading();
        try {
            const gl = this.gl;
            let program = gl.createProgram();

            const vs = this.createShader(vertexSource, gl.VERTEX_SHADER);
            const fs = this.createShader(fragmentSource, gl.FRAGMENT_SHADER);

            if (!vs || !fs) {
                this.hideLoading();
                return null;
            }

            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);

            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                this.hideLoading();
                this.onError(`Error LINK en ${pass.name}`, gl.getProgramInfoLog(program));
                return null;
            }

            // Cachear uniforms
            pass.uniformsCache = {
                time: gl.getUniformLocation(program, 'time'),
                mouse: gl.getUniformLocation(program, 'mouse'),
                resolution: gl.getUniformLocation(program, 'resolution'),
                fxrand: gl.getUniformLocation(program, 'fxrand'),
                iChannel0: gl.getUniformLocation(program, 'iChannel0'),
                iChannel1: gl.getUniformLocation(program, 'iChannel1'),
                iChannel2: gl.getUniformLocation(program, 'iChannel2'),
                iChannel3: gl.getUniformLocation(program, 'iChannel3'),
                iFrame: gl.getUniformLocation(program, 'iFrame'),
                BPM: gl.getUniformLocation(program, 'BPM'), // Global BPM support
                // Puntos (multi-usuario / lidar): tipo, tamaño y locations REALES del
                // programa. La convención + el upload viven en js/lib/jp-pointers.js.
                pointersInfo: window.JPPointers ? window.JPPointers.findUniform(gl, program) : null,
                // Puntos del LIDAR GLOBALES (`lidarPointers[30]` + `lidarPointersCount`)
                lidarPointersInfo: window.JPPointers ? window.JPPointers.findUniform(gl, program, 'lidarPointers') : null,
                // tercer array global: puntos SIMULADOS (los anima jp-sim-pointers.js en JS)
                simPointersInfo: window.JPPointers ? window.JPPointers.findUniform(gl, program, 'simulatedPointers') : null
            };

            // Tipo GL de cada uniform activo: hace falta porque un `uniform bool`
            // (o int) NO se puede subir con gl.uniform1f -> INVALID_OPERATION y el
            // valor no se aplica (el shader queda con el default). Los shaders de
            // la base tienen 20+ uniforms bool (ima_flip, gen_3Dmap, u_transparent_bg…).
            pass.uniformTypes = (window.JPUniformTypes && window.JPUniformTypes.tiposDePrograma)
                ? window.JPUniformTypes.tiposDePrograma(gl, program)
                : {};

            // ⚠ ADEMÁS de los globales hay que cachear los uniforms PROPIOS del shader
            // (los `uniform float X` que el usuario declara y los `sampler2D` de entrada).
            // Sin esto `pass.uniformsCache['u_x']` era undefined y el bind de abajo hacía
            // NADA: el slider movía el valor en el modelo pero la IMAGEN nunca cambiaba
            // (no-op silencioso: gl.uniform1f(undefined, v) no tira error).
            (function cachearPropios() {
                const fuente = fragmentSource || '';
                const re = /uniform\s+(?:lowp\s+|mediump\s+|highp\s+)?(?:float|int|bool|vec2|vec3|vec4|sampler2D)\s+(\w+)\s*;/g;
                let m;
                while ((m = re.exec(fuente)) !== null) {
                    if (m[1][0] === 'g_' || m[1].indexOf('gl_') === 0) continue;
                    if (pass.uniformsCache[m[1]] === undefined) {
                        pass.uniformsCache[m[1]] = gl.getUniformLocation(program, m[1]);
                    }
                }
                if (pass.inputAliases) {
                    Object.keys(pass.inputAliases).forEach(n => {
                        if (pass.uniformsCache[n] === undefined) pass.uniformsCache[n] = gl.getUniformLocation(program, n);
                    });
                }
            })();

            // Custom uniforms
            if (shaderParser) {
                const customUniforms = shaderParser.getUniformValues();
                for (const name of Object.keys(customUniforms)) {
                    pass.uniformsCache[name] = gl.getUniformLocation(program, name);
                }
            }

            // NODEEDITOR: locations de los samplers aliasados (aunque no haya shaderParser)
            if (pass.inputAliases) {
                for (const alias of Object.keys(pass.inputAliases)) {
                    pass.uniformsCache[alias] = gl.getUniformLocation(program, alias);
                }
            }

            // ENTRADAS DE MEDIOS: el shader las "levanta" declarando
            // `uniform sampler2D camara|depthmap|openpose;`. Se detectan del FUENTE
            // (js/lib/jp-media-inputs.js) y sólo se activan si (a) el host lo pidió
            // —mediaInputsActivos— y (b) el programa las USA de verdad: si GLSL la
            // optimiza, la location es null → el shader no la lee → no se descarga
            // nada. Así, por defecto, la página no pide permisos ni modelos.
            pass.media = null;
            if (this.mediaInputsActivos && window.JPMediaInputs) {
                try {
                    const nombres = [];
                    window.JPMediaInputs.enCodigo(fragmentSource).forEach((n) => {
                        if (pass.uniformsCache[n] === undefined) {
                            pass.uniformsCache[n] = gl.getUniformLocation(program, n);
                        }
                        if (pass.uniformsCache[n]) nombres.push(n);
                    });
                    if (nombres.length) {
                        pass.media = nombres;
                        // Lazy: pide consentimiento y baja el modelo SÓLO ahora.
                        window.JPMediaInputs.requerir(nombres);
                    }
                } catch (e) { console.warn('media inputs (compile):', e); }
            }

            if (pass.program) gl.deleteProgram(pass.program);
            pass.program = program;
            pass.code = fragmentSource;
            pass.vertexPosition = gl.getAttribLocation(program, "position");

            this.onError('', '');
            this.hideOnNextFrame = true;
            return program;
        } catch (error) {
            console.error(`Error compilando pass ${passId}:`, error);
            this.hideLoading();
            return null;
        }
    }

    /**
     * Sube UN uniform propio del shader a su location, eligiendo el `gl.uniform*`
     * correcto según el tipo REAL del programa:
     *   · float      -> uniform1f
     *   · bool/int   -> uniform1i  (uniform1f tira INVALID_OPERATION y no aplica)
     *   · vec2/3/4   -> uniform2fv/3fv/4fv  (antes NO existía: un `uniform vec3`
     *                   guardado como array se subía con uniform1f(loc, [..]) = NaN
     *                   y el pase quedaba NEGRO sin ningún error en consola)
     */
    subirUniformCustom(loc, valor, tipoGL) {
        const gl = this.gl;
        if (!loc) return;
        // Una sola implementación del upload para TODAS las superficies:
        // js/lib/uniform-types.js -> JPUniformTypes.subir().
        const JU = window.JPUniformTypes;
        if (JU && JU.subir) { JU.subir(gl, loc, valor, tipoGL); return; }
        if (typeof valor === 'number' && isFinite(valor)) gl.uniform1f(loc, valor);
    }

    /**
     * Renderiza todos los pases
     */
    render(shaderParser) {
        const gl = this.gl;
        if (!gl) return;

        // Sin tamaño no hay nada que dibujar (canvas recién creado, oculto o 0x0):
        // antes se dibujaba igual contra targets 0x0 y la consola se llenaba de
        // GL_INVALID_FRAMEBUFFER_OPERATION. El tamaño lo fija el host (resize() /
        // ajustarTamanoCanvas()); en cuanto lo fije, este render vuelve solo.
        if (!this.parameters.screenWidth || !this.parameters.screenHeight) return;

        this.parameters.time = Date.now() - this.parameters.startTime;

        // Limpiar buffer principal
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Renderizar pases en orden
        for (const passId of this.passOrder) {
            const pass = this.passes.get(passId);
            if (!pass || !pass.program) continue;

            gl.useProgram(pass.program);

            // ── ESCALA POR PASE ──────────────────────────────────────────────
            // pass.scale = 1 → tamaño del canvas. 0.5 → la MITAD por lado (1/4 de
            // píxeles). Es lo que permite resolver un fluido (20 iteraciones de
            // presión) a 256/512 px en vez de a 1920×1080.
            const escalaPase = (Number(pass.scale) > 0 && Number(pass.scale) <= 1) ? Number(pass.scale) : 1;
            const anchoPase = Math.max(1, Math.round(this.parameters.screenWidth * escalaPase));
            const altoPase = Math.max(1, Math.round(this.parameters.screenHeight * escalaPase));

            // Bind global uniforms
            gl.uniform1f(pass.uniformsCache.time, this.parameters.time / 1000);
            gl.uniform4fv(pass.uniformsCache.mouse, this.parameters.mouse);
            // `resolution` es la del PASE (no la del canvas): con escala 0.5 el
            // shader ve 0.5× y sus texel son coherentes con su propio target.
            gl.uniform2f(pass.uniformsCache.resolution, anchoPase, altoPase);
            gl.uniform1f(pass.uniformsCache.fxrand, this.parameters.fxrand);
            // BPM global. OJO: GLSL elimina los uniforms que el shader NO usa, así que la
            // location puede ser null; setear una location null es un no-op silencioso.
            // (Antes esto logueaba un warning POR FRAME: cientos por segundo en consola.)
            if (pass.uniformsCache.BPM) gl.uniform1f(pass.uniformsCache.BPM, this.parameters.bpm);
            if (pass.uniformsCache.iFrame !== null) gl.uniform1i(pass.uniformsCache.iFrame, this.parameters.iFrame);

            // Bind custom uniforms: los valores POR PASE mandan (sistema de nodos);
            // si el pase no tiene propios, se usa el mapa global del shaderParser.
            const customUniforms = (pass.uniformValues && Object.keys(pass.uniformValues).length)
                ? pass.uniformValues
                : (shaderParser ? shaderParser.getUniformValues() : {});
            if (customUniforms) {
                const skipGlobals = ['time','mouse','resolution','fxrand','BPM','bpm','iFrame','iChannel0','iChannel1','iChannel2','iChannel3','pointers','pointersCount','pointerCount','lidarPointers','lidarPointersCount','u_escalaPase','u_iteracion','u_iteraciones'];
                for (const name of Object.keys(customUniforms)) {
                    if (skipGlobals.includes(name)) continue;
                    let loc = pass.uniformsCache[name];
                    if (loc === undefined && pass.program) {
                        // primera vez: resolver y dejar cacheado (null también se cachea)
                        loc = pass.uniformsCache[name] = gl.getUniformLocation(pass.program, name);
                    }
                    if (loc) {
                        // Guard: un valor no numerico (p.ej. un objeto {value,min,max}
                        // que se colo desde la DB) hacia gl.uniform1f(loc, {…}) = NaN y
                        // el pase quedaba NEGRO sin ningun error. Mejor no setear.
                        // Los bool/int van con uniform1i y los vec con uniform2/3/4fv
                        // (ver subirUniformCustom).
                        this.subirUniformCustom(loc, customUniforms[name],
                            pass.uniformTypes ? pass.uniformTypes[name] : undefined);
                    }
                }
            }

            // ESCALA del pase como uniform: los puntos (pointers[]) llegan en px
            // del CANVAS, así que para pasarlos a uv del pase hace falta
            // `act * u_escalaPase / resolution`. Lo setea el renderer y va DESPUÉS
            // de los uniforms custom: si se setea antes, el default 0.5 del
            // shaderParser lo pisa (fue exactamente el bug del mapeo).
            let locEscala = pass.uniformsCache.u_escalaPase;
            if (locEscala === undefined) {
                locEscala = pass.uniformsCache.u_escalaPase = gl.getUniformLocation(pass.program, 'u_escalaPase');
            }
            if (locEscala) gl.uniform1f(locEscala, escalaPase);

            // Puntos: se suben a `pointers[N]` (.xy actual, .zw anterior, en píxeles) +
            // `pointersCount` (y el alias `pointerCount` de los shaders viejos).
            // El upload se adapta al tipo/tamaño que declare el shader (vec2/vec3/vec4,
            // cualquier N) — vive en js/lib/jp-pointers.js.
            if (window.JPPointers && pass.uniformsCache.pointersInfo) {
                window.JPPointers.upload(
                    gl,
                    pass.uniformsCache.pointersInfo,
                    this.parameters.pointers || [],
                    this.parameters.prevPointers || (this.parameters.prevPointers = []),
                    this.parameters.screenWidth,
                    this.parameters.screenHeight
                );
            }

            // Puntos del LIDAR (GLOBALES): se suben a `lidarPointers[N]` + `lidarPointersCount`
            // con el MISMO mecanismo. Cualquier shader los puede leer.
            if (window.JPPointers && pass.uniformsCache.lidarPointersInfo) {
                window.JPPointers.upload(
                    gl,
                    pass.uniformsCache.lidarPointersInfo,
                    this.parameters.lidarPointers || [],
                    this.parameters.prevLidarPointers || (this.parameters.prevLidarPointers = []),
                    this.parameters.screenWidth,
                    this.parameters.screenHeight
                );
            }

            // Puntos SIMULADOS (los mueve JavaScript, con atraccion al mouse/dedos/lidar)
            if (window.JPPointers && pass.uniformsCache.simPointersInfo) {
                window.JPPointers.upload(
                    gl,
                    pass.uniformsCache.simPointersInfo,
                    this.parameters.simulatedPointers || [],
                    this.parameters.prevSimulatedPointers || (this.parameters.prevSimulatedPointers = []),
                    this.parameters.screenWidth,
                    this.parameters.screenHeight
                );
            }

            // ── ITERACIONES POR PASE ─────────────────────────────────────────
            // Un pase puede dibujarse N veces por frame (ping-pong entre sus dos
            // targets). Es lo que hace posible un solver iterativo (presión del
            // fluido: ~20 Jacobi) sin crear 20 buffers: es el MISMO pase.
            // Los shaders reciben `u_iteracion` (0..N-1) y `u_iteraciones` (N),
            // así pueden limpiar/arrancar distinto en la primera iteración.
            const iteraciones = this._normalizarIteraciones(pass.iterations);
            for (let it = 0; it < iteraciones; it++) {
                let locIt = pass.uniformsCache.u_iteracion;
                if (locIt === undefined && pass.program) {
                    locIt = pass.uniformsCache.u_iteracion = gl.getUniformLocation(pass.program, 'u_iteracion');
                    pass.uniformsCache.u_iteraciones = gl.getUniformLocation(pass.program, 'u_iteraciones');
                }
                if (locIt) gl.uniform1f(locIt, it);
                if (pass.uniformsCache.u_iteraciones) gl.uniform1f(pass.uniformsCache.u_iteraciones, iteraciones);

            // Bind connections (iChannels)
            for (let i = 0; i < 4; i++) {
                const input = pass.inputs[i];
                const loc = pass.uniformsCache[`iChannel${i}`];
                if (!loc) continue;

                gl.activeTexture(gl.TEXTURE0 + i);
                let tex = this.blankTexture;

                if (input) {
                    if (input.type === 'buffer') {
                        const inputPass = this.passes.get(input.id);
                        if (inputPass && inputPass.renderTargets[0]) {
                            // Usar el back buffer del pase de entrada (el que ya fue renderizado en el frame anterior)
                            const inputBack = 1 - inputPass.currentFront;
                            tex = inputPass.renderTargets[inputBack].texture;
                        }
                    } else if (input.type === 'texture') {
                        tex = this.inputTextures[input.id] || this.blankTexture;
                    } else if (input.type === 'self') {
                        // Feedback del mismo pase
                        const back = 1 - pass.currentFront;
                        tex = pass.renderTargets[back].texture;
                    } else if (input.type === 'texture_url') {
                        // Dynamic texture from URL
                        tex = this.getTextureFromUrl(input.id) || this.blankTexture;
                    }
                }

                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.uniform1i(loc, i);

                // NODEEDITOR: alias de entrada (tex0/inputImage/… del shader apuntan al
                // mismo texture unit que el iChannel conectado).
                if (pass.inputAliases) {
                    for (const alias in pass.inputAliases) {
                        if (pass.inputAliases[alias] !== i) continue;
                        let aLoc = pass.uniformsCache[alias];
                        if (aLoc === undefined && pass.program) {
                            aLoc = pass.uniformsCache[alias] = gl.getUniformLocation(pass.program, alias);
                        }
                        if (aLoc) gl.uniform1i(aLoc, i);
                    }
                }
            }

            // ENTRADAS DE MEDIOS: se bindean en las unidades 4/5/6 (los iChannel usan
            // 0..3). La textura la da el módulo (crea una POR CONTEXTO WebGL); si la
            // fuente todavía no está (bajando modelo / sin permiso) se usa la
            // blankTexture → el shader ve negro, no basura del texture unit anterior.
            if (pass.media && window.JPMediaInputs) {
                for (const nombre of pass.media) {
                    const loc = pass.uniformsCache[nombre];
                    if (!loc) continue;
                    const unidad = window.JPMediaInputs.UNITS[nombre];
                    if (unidad == null) continue;
                    gl.activeTexture(gl.TEXTURE0 + unidad);
                    const tex = window.JPMediaInputs.textura(gl, nombre) || this.blankTexture;
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.uniform1i(loc, unidad);
                }
                gl.activeTexture(gl.TEXTURE0);
            }

            // Bind attributes
            gl.bindBuffer(gl.ARRAY_BUFFER, this.commonBuffer);
            gl.enableVertexAttribArray(pass.vertexPosition);
            gl.vertexAttribPointer(pass.vertexPosition, 2, gl.FLOAT, false, 0, 0);

            // Dibujar al Render Target del pase o a pantalla
            if (pass.type === 'buffer' || pass.type === 'image') {
                const front = pass.currentFront;
                const ancho = anchoPase;
                const alto = altoPase;
                let target = pass.renderTargets[front];

                // Auto-reparación del target: si no existe, quedó incompleto o su
                // tamaño no es el actual (se creó antes de conocerlo, p.ej. addPass()
                // con screenWidth=0 o cambió la escala), se rearma acá con el tamaño
                // real en vez de dibujar contra un framebuffer incompleto.
                if (!target || target.completo === false || target.width !== ancho || target.height !== alto) {
                    const filtro = (passId === 'buffer2' || passId === 'buffer3') ? 'NEAREST' : 'LINEAR';
                    pass.renderTargets[0] = this.reemplazarTarget(pass.renderTargets[0], ancho, alto, filtro);
                    pass.renderTargets[1] = this.reemplazarTarget(pass.renderTargets[1], ancho, alto, filtro);
                    target = pass.renderTargets[front];
                }

                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.viewport(0, 0, ancho, alto);
                gl.drawArrays(gl.TRIANGLES, 0, 6);

                // Si este es el pase que queremos PREVISUALIZAR (o es el main por defecto),
                // dibujamos a pantalla. El viewport de pantalla es el del CANVAS, no el del pase.
                const isDisplayPass = this.displayPassId === passId ||
                    (pass.type === 'image' && this.displayPassId === 'main');
                if (isDisplayPass && it === iteraciones - 1) {
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.viewport(0, 0, this.parameters.screenWidth, this.parameters.screenHeight);
                    // ⚠ RESOLUCION DEL DRAW A PANTALLA. `resolution` es la del PASE
                    // (con escala 0.4 el pase vive a 480x280), pero aca se pinta en un
                    // viewport del tamaño del CANVAS: el shader calculaba
                    // uv = gl_FragCoord.xy / resolution con gl_FragCoord hasta 1200 y
                    // resolution 480 -> uv 0..2.5, o sea la imagen aparecia SOLO en la
                    // esquina inferior izquierda, escalada. Es lo que pasaba al mirar un
                    // buffer con el ojo. Para este draw el shader tiene que ver el canvas.
                    if (pass.uniformsCache.resolution) {
                        gl.uniform2f(pass.uniformsCache.resolution,
                            this.parameters.screenWidth, this.parameters.screenHeight);
                    }
                    gl.drawArrays(gl.TRIANGLES, 0, 6);
                }

                // Swap buffers (ping-pong)
                pass.currentFront = 1 - pass.currentFront;
            } // fin del if (pass.type === 'buffer' || 'image')
            } // fin del for de iteraciones
        } // fin del for de pases

        if (this.hideOnNextFrame) {
            this.hideOnNextFrame = false;
            this.hideLoading();
        }

        this.parameters.iFrame++;
    }

    createBlankTexture() {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
    }

    createShader(src, type) {
        const gl = this.gl;
        let shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const errorInfo = gl.getShaderInfoLog(shader);
            this.onError('SHADER ERROR', errorInfo);
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    updateInputTexture(index, imageBitmap) {
        const slot = index - 1;
        if (slot < 0 || slot > 2) return;
        if (this.inputTextures[slot]) this.gl.deleteTexture(this.inputTextures[slot]);
        this.inputTextures[slot] = this.createGLTextureFromImage(imageBitmap);
    }

    createGLTextureFromImage(image) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
    }

    ajustarTamanoCanvas(container) {
        const rect = container.getBoundingClientRect();
        // Un contenedor oculto o sin layout devuelve 0x0: NO se redimensiona a 0
        // (dejaba targets 0x0 = framebuffer incompleto). Se conserva el tamaño
        // anterior hasta que haya layout real.
        let w = Math.floor(rect.width);
        let h = Math.floor(rect.height);
        if (!(w > 0)) w = this.canvas.width || 1;
        if (!(h > 0)) h = this.canvas.height || 1;
        w = Math.max(1, w);
        h = Math.max(1, h);

        this.canvas.width = w;
        this.canvas.height = h;
        this.parameters.screenWidth = w;
        this.parameters.screenHeight = h;

        // Recrear targets para cada pase
        for (const [id, pass] of this.passes.entries()) {
            if (pass.type === 'buffer' || pass.type === 'image') {
                const filter = (id === 'buffer2' || id === 'buffer3') ? 'NEAREST' : 'LINEAR';
                pass.renderTargets.forEach((t, i) => {
                    pass.renderTargets[i] = this.reemplazarTarget(t, this.canvas.width, this.canvas.height, filter);
                });
            }
        }
    }

    updateMouse(x, y, z, w) {
        if (x !== undefined) this.parameters.mouse[0] = x;
        if (y !== undefined) this.parameters.mouse[1] = y;
        if (z !== undefined) this.parameters.mouse[2] = z;
        if (w !== undefined) this.parameters.mouse[3] = w;
    }

    /**
     * Helper to load/get texture from a URL.
     * Use a simple cache to avoid redundant loads.
     */
    getTextureFromUrl(url) {
        if (!this.urlTextureCache) this.urlTextureCache = {};

        if (this.urlTextureCache[url]) {
            return this.urlTextureCache[url].texture;
        }

        const gl = this.gl;
        const texture = gl.createTexture();
        this.urlTextureCache[url] = { texture: texture, status: 'loading' };

        // Bind fake 1x1 initially (transparente)
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

        const isPowerOfTwo = (x) => (x & (x - 1)) === 0;

        const image = new Image();
        image.crossOrigin = "anonymous"; // Important for external images
        image.onload = () => {
            if (!gl) return;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

            if (isPowerOfTwo(image.width) && isPowerOfTwo(image.height)) {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                gl.generateMipmap(gl.TEXTURE_2D);
            } else {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            }

            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.bindTexture(gl.TEXTURE_2D, null);
            this.urlTextureCache[url].status = 'ready';
        };
        image.onerror = (e) => {
            console.error('Failed to load texture URL:', url, e);
            this.urlTextureCache[url].status = 'error';
        };
        image.src = url;

        return texture;
    }
}
