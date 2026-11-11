/* =============================================================================
   uniform-types.js — TIPOS DE UNIFORMS DECLARADOS EN EL SHADER
   -----------------------------------------------------------------------------
   Los shaders de la base declaran algunos uniforms como `uniform bool` (p.ej.
   ima_flip tiene flipx/mirrorx/flipy/mirrory, gen_3Dmap mirror, gen_eclipse
   estrellas, los raymarching u_transparent_bg…). Hasta ahora todo el front
   buscaba SOLO `uniform float`, así que esos bools no tenían control: no se
   podían prender/apagar (el uniform quedaba en false para siempre).

   Este módulo centraliza la detección para que las tres superficies (editor,
   performance y nodos) puedan dibujar un SWITCH en vez de un slider, y para que
   los renderers sepan que a un bool/int hay que subirlo con `gl.uniform1i`
   (con `uniform1f` WebGL tira INVALID_OPERATION y el pase queda negro).

   Uso:
     JPUniformTypes.declarados('... uniform bool mirror; ...')  // Map(nombre -> tipo)
     JPUniformTypes.bools(codigo)                                // ['mirror']
     JPUniformTypes.tiposDeVarios([codeA, codeB])                // merge de varios pases
     JPUniformTypes.esGlobal('iTime')                            // true
   ============================================================================= */
(function (root) {
    'use strict';

    // Uniforms del sistema: los maneja el renderer, NO son sliders del usuario.
    var GLOBALES = [
        'time', 'mouse', 'resolution', 'fxrand', 'backbuffer', 'bpm', 'BPM',
        'iFrame', 'iTime', 'iGlobalTime', 'iResolution', 'iMouse',
        'pointers', 'pointersCount', 'pointerCount',
        'lidarPointers', 'lidarPointersCount',
        // ENTRADAS DE MEDIOS (js/lib/jp-media-inputs.js): son sampler2D que levanta
        // el renderer cuando el shader los DECLARA. No son sliders ni alias de
        // iChannel: si no se excluyen acá, el editor/nodos les dibuja un slider.
        'camara', 'camera', 'webcam', 'depthmap', 'depth_map', 'openpose', 'open_pose'
    ];

    // Tipos que sabemos subir desde el front. `sampler2D` no es un slider (es una
    // textura) pero se reconoce para no confundirlo con un float.
    var TIPOS = ['float', 'bool', 'int', 'vec2', 'vec3', 'vec4', 'mat3', 'mat4', 'sampler2D'];
    // Tipos VECTORIALES: su valor canónico es un ARRAY de N componentes 0..1 y se
    // dibujan con control propio (pad XY / color picker / N sliders) en vez de un
    // slider suelto. Ver js/lib/uniform-controls.js.
    var VECTORES = ['vec2', 'vec3', 'vec4'];


    var RE = new RegExp('uniform\\s+(' + TIPOS.join('|') + ')\\s+(\\w+)\\s*(\\[[^\\]]*\\])?\\s*;', 'g');

    function esGlobal(nombre) {
        if (!nombre) return true;
        if (GLOBALES.indexOf(nombre) !== -1) return true;
        if (/^iChannel\d$/.test(nombre)) return true;      // entradas conectadas
        if (/^imageInput/.test(nombre)) return true;       // compat shaders viejos
        return false;
    }

    // Map(nombre -> 'float'|'bool'|…) de todos los uniforms declarados, sin claves
    // repetidas (gana la primera aparición) y sin los del sistema.
    function declarados(codigo) {
        var out = new Map();
        if (!codigo) return out;
        RE.lastIndex = 0;
        var m;
        while ((m = RE.exec(String(codigo))) !== null) {
            var tipo = m[1], nombre = m[2];
            if (esGlobal(nombre)) continue;
            if (!out.has(nombre)) out.set(nombre, tipo);
        }
        return out;
    }

    // Nombres declarados como `uniform bool` (para dibujar switches).
    function bools(codigo) {
        var out = [];
        declarados(codigo).forEach(function (tipo, nombre) {
            if (tipo === 'bool') out.push(nombre);
        });
        return out;
    }

    // Igual que `bools` pero mezclando VARIOS códigos (todos los pases de un shader).
    function boolsDeVarios(codigos) {
        var out = [];
        (codigos || []).forEach(function (c) {
            bools(c).forEach(function (n) { if (out.indexOf(n) === -1) out.push(n); });
        });
        return out;
    }

    // Merge de los tipos de varios códigos.
    function tiposDeVarios(codigos) {
        var out = new Map();
        (codigos || []).forEach(function (c) {
            declarados(c).forEach(function (tipo, nombre) {
                if (!out.has(nombre)) out.set(nombre, tipo);
            });
        });
        return out;
    }

    // true si ese uniform (en ese código) es bool.
    function esBool(codigo, nombre) {
        var d = declarados(codigo).get(nombre);
        return d === 'bool';
    }

    // ---- VECTORES (vec2/vec3/vec4) ------------------------------------------
    // Cantidad de componentes de un tipo declarado ('vec3' -> 3; el resto -> 1).
    function componentes(tipo) {
        var t = String(tipo || '').replace(/\b(lowp|mediump|highp)\b/g, '').trim();
        if (t === 'vec2') return 2;
        if (t === 'vec3') return 3;
        if (t === 'vec4') return 4;
        return 1;
    }

    function esVector(tipo) {
        return VECTORES.indexOf(String(tipo || '').trim()) !== -1;
    }

    // Nombres declarados como vec2/vec3/vec4 en un código (para las superficies
    // que quieran saberlo sin repetir el regex).
    function vectores(codigo) {
        var out = [];
        declarados(codigo).forEach(function (tipo, nombre) {
            if (esVector(tipo)) out.push({ nombre: nombre, tipo: tipo });
        });
        return out;
    }

    // Cantidad de componentes de un tipo GL (FLOAT_VEC3 -> 3, INT_VEC2 -> 2, …).
    // Hace falta en los renderers: un `uniform vec3` NO se sube con uniform1f.
    function componentesDeTipoGL(gl, tipo) {
        if (tipo === undefined || tipo === null || !gl) return 0;
        if (tipo === gl.FLOAT_VEC2 || tipo === gl.INT_VEC2 || tipo === gl.BOOL_VEC2 ||
            (gl.UNSIGNED_INT_VEC2 !== undefined && tipo === gl.UNSIGNED_INT_VEC2)) return 2;
        if (tipo === gl.FLOAT_VEC3 || tipo === gl.INT_VEC3 || tipo === gl.BOOL_VEC3 ||
            (gl.UNSIGNED_INT_VEC3 !== undefined && tipo === gl.UNSIGNED_INT_VEC3)) return 3;
        if (tipo === gl.FLOAT_VEC4 || tipo === gl.INT_VEC4 || tipo === gl.BOOL_VEC4 ||
            (gl.UNSIGNED_INT_VEC4 !== undefined && tipo === gl.UNSIGNED_INT_VEC4)) return 4;
        return 0;
    }


    // Sube UN valor a una location eligiendo el `gl.uniform*` correcto según el tipo
    // REAL del programa. Es la ÚNICA implementación del upload: la usan el renderer
    // del editor, el del include, el preview y la salida de performance (antes cada
    // uno tenía su versión y sólo manejaba escalares: un `uniform vec3` guardado como
    // array se subía con uniform1f(loc, [..]) = NaN y el pase quedaba NEGRO).
    // Acepta número, booleano, array, TypedArray y {value: …}.
    // Devuelve true si subió algo.
    function subir(gl, loc, valor, tipo) {
        if (!gl || !loc || valor === undefined || valor === null) return false;
        if (valor.buffer && typeof valor.length === 'number' && typeof valor.map !== 'function') {
            valor = Array.prototype.slice.call(valor);
        }
        // desenvolver {value: …} (formato DB/performance)
        if (valor && typeof valor === 'object' && !Array.isArray(valor) && 'value' in valor) {
            return subir(gl, loc, valor.value, tipo);
        }
        if (Array.isArray(valor)) {
            var n = componentesDeTipoGL(gl, tipo) || valor.length;
            if (n < 2 || n > 4) return false;
            var vals = [];
            for (var i = 0; i < n; i++) {
                var x = Number(valor[i]);
                vals.push(isFinite(x) ? x : 0);
            }
            // completa lo que falte (un vec4 con 3 componentes: alpha = 1)
            while (vals.length < n) vals.push(vals.length === 3 ? 1 : 0);
            if (esEntero(gl, tipo)) {
                var iv = new Int32Array(n);
                for (var j = 0; j < n; j++) iv[j] = vals[j] ? 1 : 0;
                if (n === 2) gl.uniform2iv(loc, iv);
                else if (n === 3) gl.uniform3iv(loc, iv);
                else gl.uniform4iv(loc, iv);
            } else {
                var fv = new Float32Array(n);
                for (var k = 0; k < n; k++) fv[k] = vals[k];
                if (n === 2) gl.uniform2fv(loc, fv);
                else if (n === 3) gl.uniform3fv(loc, fv);
                else gl.uniform4fv(loc, fv);
            }
            return true;
        }
        if (typeof valor === 'boolean') { gl.uniform1i(loc, valor ? 1 : 0); return true; }
        if (typeof valor === 'number' && isFinite(valor)) {
            if (esEntero(gl, tipo)) gl.uniform1i(loc, valor ? 1 : 0);
            else gl.uniform1f(loc, valor);
            return true;
        }
        return false;
    }

    // Normaliza cualquier valor guardado (número, booleano, {value}) a 0/1.
    function aBool(valor) {
        if (typeof valor === 'boolean') return valor ? 1 : 0;
        if (typeof valor === 'number') return valor ? 1 : 0;
        if (valor && typeof valor.value === 'number') return valor.value ? 1 : 0;
        if (valor && typeof valor.value === 'boolean') return valor.value ? 1 : 0;
        return 0;
    }

    // ---- Ayudas para los RENDERERS -------------------------------------------
    // Un uniform bool/int NO se puede subir con gl.uniform1f: WebGL tira
    // INVALID_OPERATION y el valor no se aplica (el pase queda con el default,
    // típicamente negro). Hay que usar gl.uniform1i.
    function esEntero(gl, tipo) {
        if (tipo === undefined || tipo === null) return false;
        if (tipo === gl.BOOL || tipo === gl.INT) return true;          // 5124 / 5125
        if (gl.BOOL_VEC2 && (tipo === gl.BOOL_VEC2 || tipo === gl.BOOL_VEC3 || tipo === gl.BOOL_VEC4)) return true;
        if (gl.INT_VEC2 && (tipo === gl.INT_VEC2 || tipo === gl.INT_VEC3 || tipo === gl.INT_VEC4)) return true;
        if (gl.SAMPLER_2D && tipo === gl.SAMPLER_2D) return true;
        if (gl.UNSIGNED_INT && (tipo === gl.UNSIGNED_INT || tipo === gl.UNSIGNED_INT_VEC2 ||
            tipo === gl.UNSIGNED_INT_VEC3 || tipo === gl.UNSIGNED_INT_VEC4)) return true;
        return false;
    }

    // Mapa nombre -> tipo GL de todos los uniforms activos de un programa.
    // Los arrays llegan como `nombre[0]`; se indexa también sin corchetes.
    function tiposDePrograma(gl, program) {
        var out = {};
        try {
            var n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
            for (var i = 0; i < n; i++) {
                var info = gl.getActiveUniform(program, i);
                if (!info) continue;
                out[info.name] = info.type;
                var base = info.name.replace(/\[0\]$/, '');
                if (base !== info.name) out[base] = info.type;
            }
        } catch (e) { /* programa inválido: sin tipos */ }
        return out;
    }

    var api = {
        GLOBALES: GLOBALES,
        TIPOS: TIPOS,
        VECTORES: VECTORES,
        esGlobal: esGlobal,
        declarados: declarados,
        bools: bools,
        boolsDeVarios: boolsDeVarios,
        tiposDeVarios: tiposDeVarios,
        esBool: esBool,
        aBool: aBool,
        esEntero: esEntero,
        tiposDePrograma: tiposDePrograma,
        componentes: componentes,
        esVector: esVector,
        vectores: vectores,
        componentesDeTipoGL: componentesDeTipoGL,
        subir: subir
    };
    // DUAL: en el navegador queda en window; en Node (el server arma el plan de
    // inclusión con buildRenderPlan) se exporta por require. Antes hacía sólo
    // `window.JPUniformTypes = ...` y requerirlo desde Node explotaba.
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.JPUniformTypes = api;
})(typeof self !== 'undefined' ? self : this);
