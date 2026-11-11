// jp-pointers.js — SISTEMA DE PUNTOS (pointers) del JP Shader Editor.
// FUENTE UNICA. Lo usan:
//   · jp-shader-header.js  (header de compilación del editor y del include)
//   · jp-node-graph.js     (header del grafo de nodos / composiciones)
//   · webglrenderer.js     (editor, performance salida, include: sube los valores)
//   · performanceoutput.js (su propio motor GL: sube los valores)
//
// CONVENCIÓN (una sola, para que un shader ande igual en TODOS lados):
//     uniform vec4 pointers[N];   // .xy = posición ACTUAL en PÍXELES
//                                 // .zw = posición ANTERIOR en píxeles (para estelas/velocidad)
//     uniform int  pointersCount; // cuántos puntos hay cargados (0..N)
//   Alias de compatibilidad: si el shader declara/usá `pointerCount`, también se setea.
//
// PUNTOS DEL LIDAR (GLOBALES — lo que pidió el usuario):
//     uniform vec4 lidarPointers[30];  // idem, pero los reparte el SERVIDOR a TODOS los shaders
//     uniform int  lidarPointersCount; //
//     #define JP_LIDAR_POINTERS_MAX 30 //
//   La app del LIDAR los manda a `POST /api/pointers` (source 'lidar-app') y el servidor los
//   reenvía a TODAS las pestañas por socket (`lidarPointersUpdate`). Así CUALQUIER shader puede
//   usar los puntos del lidar escribiendo esos uniforms: no hace falta que se llame lidar-puntos.
//
// Los shaders PUEDEN declarar sus propios arrays con otro tamaño/tipo (vec2/vec3/vec4) —
// hay shaders viejos tipo GAS con `uniform vec3 pointers[10];`. El header respeta lo
// que declare el shader y el upload se adapta al tipo y tamaño REALES del programa
// (gl.getActiveUniform), así que ninguno se rompe.
//
// ⚠ El bug que dejó esta feature muerta desde el día uno: el header declaraba
// `uniform vec4 pointers[32];` si el fuente no matcheaba el RegExp
// /uniform\s+vec4\s+pointers[32]/ — y `[32]` en un RegExp es una CLASE DE CARACTERES
// (matchea '3' o '2'), así que el check NUNCA daba true y TODO shader que declarara
// pointers moría con "'pointers' : redefinition". Acá el check es correcto
// (`/uniform\s+\w+\s+pointers\s*\[/`) y hay un solo lugar donde vive.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.JPPointers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var DEFAULT_SIZE = 256;   // puntos que declara el header cuando el shader no declara nada

    // Tope de puntos que el SERVIDOR reenvía por shader/sesión (server.js: LIMITE_PUNTOS).
    // Es una COTA SUPERIOR: cada shader recibe como máximo lo que declare en su array.
    var SERVER_LIMIT = 1024;

    // Puntos del LIDAR: GLOBALES. 30 = lo que necesita la instalación (y lo que declara
    // `lidar-puntos`). MÁS de ~1000 NO LINKEA en GPUs con MAX_FRAGMENT_UNIFORM_VECTORS = 1024.
    var LIDAR_SIZE = 30;

    // Puntos SIMULADOS (los anima js/lib/jp-sim-pointers.js en JavaScript y los sube
    // el renderer igual que los otros dos arrays). 64 alcanza para el enjambre.
    var SIM_SIZE = 64;

    // El fuente SIN comentarios: los tests de "¿ya lo declara?" tienen que ignorarlos,
    // si no un simple comentario que mencione `uniform int pointersCount;` hace que el
    // header no lo declare y el shader no compile ("undeclared identifier").
    function sinComentarios(src) {
        return String(src || '')
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');
    }

    // ¿El shader declara su propio array de pointers / su propio count?
    function declaraArray(source) {
        return /uniform\s+\w+\s+pointers\s*\[/.test(sinComentarios(source));
    }
    // Tamaño del array declarado por el shader (0 si no declara).
    function sizeDeclarado(source) {
        var m = /uniform\s+\w+\s+pointers\s*\[\s*(\d+)\s*\]/.exec(sinComentarios(source));
        return m ? parseInt(m[1], 10) : 0;
    }
    function declaraCount(source) {
        return /uniform\s+int\s+pointers?Count\s*;/.test(sinComentarios(source));
    }
    // Declaraciones que hay que anteponer (vacío si el shader ya las trae).
    // Siempre define JP_POINTERS_MAX con el tamaño REAL: los shaders necesitan una
    // cota constante para el loop (GLSL ES 1.00 no permite `i < pointersCount`).
    function headerDecls(source) {
        var out = '';
        var limpio = sinComentarios(source);
        var size = sizeDeclarado(source);
        if (!size) {
            size = DEFAULT_SIZE;
            out += 'uniform vec4 pointers[' + DEFAULT_SIZE + '];   // .xy actual (px)  .zw anterior (px)\n';
        }
        if (!declaraCount(source)) {
            out += 'uniform int pointersCount;\n';
        }
        out += '#define JP_POINTERS_MAX ' + size + '\n';

        // --- Puntos del LIDAR (GLOBALES, los reparte el servidor a TODOS los shaders) ---
        var lm = /uniform\s+\w+\s+lidarPointers\s*\[\s*(\d+)\s*\]/.exec(limpio);
        var lsize = lm ? parseInt(lm[1], 10) : 0;
        if (!lsize) {
            lsize = LIDAR_SIZE;
            out += 'uniform vec4 lidarPointers[' + LIDAR_SIZE + '];   // .xy actual (px)  .zw anterior (px)\n';
        }
        if (!/uniform\s+int\s+lidarPointersCount\s*;/.test(limpio)) {
            out += 'uniform int lidarPointersCount;\n';
        }
        out += '#define JP_LIDAR_POINTERS_MAX ' + lsize + '\n';

        // --- Puntos SIMULADOS (los mueve JavaScript, con atraccion al mouse/dedos/lidar) ---
        var sm = /uniform\s+\w+\s+simulatedPointers\s*\[\s*(\d+)\s*\]/.exec(limpio);
        var ssize = sm ? parseInt(sm[1], 10) : 0;
        if (!ssize) {
            ssize = SIM_SIZE;
            out += 'uniform vec4 simulatedPointers[' + SIM_SIZE + '];   // .xy actual (px)  .zw anterior (px) · y = 0 ARRIBA\n';
        }
        if (!/uniform\s+int\s+simulatedPointersCount\s*;/.test(limpio)) {
            out += 'uniform int simulatedPointersCount;\n';
        }
        out += '#define JP_SIM_POINTERS_MAX ' + ssize + '\n';
        return out;
    }

    // Info real del uniform de puntos (`baseName` = 'pointers' o 'lidarPointers')
    // en un programa compilado.
    function findUniform(gl, program, baseName) {
        var base = baseName || 'pointers';
        var info = { pointers: null, count: null, countAlias: null, size: 0, comps: 4, type: 0 };
        try {
            info.pointers = gl.getUniformLocation(program, base);
            info.count = gl.getUniformLocation(program, base + 'Count');
            // Alias histórico sólo para el array principal (`pointerCount`).
            info.countAlias = (base === 'pointers') ? gl.getUniformLocation(program, 'pointerCount') : null;
            var n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
            for (var i = 0; i < n; i++) {
                var u = gl.getActiveUniform(program, i);
                if (!u) continue;
                var nombre = String(u.name).replace(/\[0\]$/, '');
                if (nombre !== base) continue;
                info.size = u.size || 0;
                info.type = u.type;
                info.comps = (u.type === gl.FLOAT_VEC2) ? 2 : (u.type === gl.FLOAT_VEC3) ? 3 : 4;
            }
        } catch (e) { /* programa incompleto: se ignora */ }
        return info;
    }

    // Sube los puntos al programa. `points` = [{x,y}] normalizados 0..1.
    // `prevStore` = array reutilizable donde se guarda la posición anterior.
    // Devuelve cuántos puntos se subieron (0 si el programa no usa el array).
    function upload(gl, info, points, prevStore, w, h) {
        if (!info || !info.pointers) return 0;
        var max = info.size > 0 ? info.size : 32;
        var comps = info.comps || 4;
        var list = Array.isArray(points) ? points : [];
        var count = Math.min(list.length, max);
        var flat = new Float32Array(max * comps);
        for (var i = 0; i < count; i++) {
            var p = list[i] || {};
            var prev = (prevStore && prevStore[i]) || p;
            var o = i * comps;
            flat[o] = (p.x || 0) * w;
            flat[o + 1] = (p.y || 0) * h;
            if (comps >= 3) flat[o + 2] = 0;
            if (comps === 4) {
                flat[o + 2] = (prev.x !== undefined ? prev.x : (p.x || 0)) * w;
                flat[o + 3] = (prev.y !== undefined ? prev.y : (p.y || 0)) * h;
            }
            if (prevStore) prevStore[i] = { x: p.x || 0, y: p.y || 0 };
        }
        if (comps === 2) gl.uniform2fv(info.pointers, flat);
        else if (comps === 3) gl.uniform3fv(info.pointers, flat);
        else gl.uniform4fv(info.pointers, flat);
        if (info.count) gl.uniform1i(info.count, count);
        if (info.countAlias) gl.uniform1i(info.countAlias, count);
        return count;
    }

    return {
        DEFAULT_SIZE: DEFAULT_SIZE,
        SERVER_LIMIT: SERVER_LIMIT,
        LIDAR_SIZE: LIDAR_SIZE,
        SIM_SIZE: SIM_SIZE,
        sinComentarios: sinComentarios,
        declaraArray: declaraArray,
        sizeDeclarado: sizeDeclarado,
        declaraCount: declaraCount,
        headerDecls: headerDecls,
        findUniform: findUniform,
        upload: upload
    };
});
