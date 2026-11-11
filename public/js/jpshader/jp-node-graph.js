/* ============================================================
   jp-node-graph — RESOLVEDOR DEL GRAFO DE NODOS (compartido)
   ------------------------------------------------------------
   Traduce una COMPOSICIÓN del nodeeditor (cajas + cables + uniforms)
   al plan de render que come el WebGLRenderer.

   Es la MISMA lógica que usa el nodeeditor para dibujar de fondo, pero
   extraída a un módulo para que la usen LOS DOS lados:

     · BACKEND (server.js)  → require('./public/js/lib/jp-node-graph.js')
       arma el plan y lo sirve ya resuelto (GLSL final incluido), así el
       navegador que embebe la composición no compila el grafo.
     · FRONT (nodeeditor.js) → window.JPNodeGraph
       la reusa en vez de mantener una copia (una sola fuente de verdad).

   UMD: funciona en Node y en el navegador sin build step.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./jp-pointers.js'));
  else root.JPNodeGraph = factory(root.JPPointers);
})(typeof self !== 'undefined' ? self : this, function (JPPointers) {
  'use strict';

  var SLOTS = 4;

  var VERTEX = [
    'attribute vec3 position;',
    'attribute vec2 surfacePosAttrib;',
    'varying vec2 surfacePosition;',
    'void main() {',
    '    surfacePosition = surfacePosAttrib;',
    '    gl_Position = vec4(position, 1.0);',
    '}'
  ].join('\n');

  var GLOBAL_UNI = ['time', 'mouse', 'resolution', 'fxrand', 'backbuffer', 'bpm', 'BPM',
    'iFrame', 'iTime', 'iGlobalTime', 'iResolution', 'iMouse', 'pointers', 'pointersCount',
    'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3',
    // ENTRADAS DE MEDIOS (js/lib/jp-media-inputs.js): el renderer las bindea SOLO
    // cuando el shader declara `uniform sampler2D camara|depthmap|openpose;`. No
    // deben aparecer como slider ni aliasarse a un inlet (le robaría el binding).
    'camara', 'camera', 'webcam', 'depthmap', 'depth_map', 'openpose', 'open_pose'];

  // ---------------------------------------------------------------- uniforms
  // Tipos de uniform declarados (compartido con editor/performance: js/lib/uniform-types.js).
  // Si por caché vieja el módulo no está, se cae a los regex de siempre (float only).
  // ⚠ Este archivo corre TAMBIÉN en Node: server.js lo requiere para armar el plan
  // de inclusión (buildRenderPlan). Por eso NO se puede tocar `window` pelado:
  // con `var JU = window.JPUniformTypes` CADA composición daba
  // /api/include/plan?comp=… → 500 'Error armando el plan'
  // (ReferenceError: window is not defined). En el navegador se sigue leyendo de
  // window EN CADA LLAMADA, porque uniform-types.js puede cargarse después.
  var JU_NODE = null;
  if (typeof window === 'undefined' && typeof require === 'function') {
    try { JU_NODE = require('./uniform-types.js'); } catch (e) { JU_NODE = null; }
  }
  function tiposUniformes(code) {
    var JU = (typeof window !== 'undefined' && window.JPUniformTypes) ? window.JPUniformTypes : JU_NODE;
    if (JU && typeof JU.declarados === 'function') return JU.declarados(code);
    var out = new Map(), m, re = /uniform\s+float\s+(\w+)\s*;/g;
    while ((m = re.exec(code || '')) !== null) if (!out.has(m[1])) out.set(m[1], 'float');
    return out;
  }

  function uniformSpecs(code) {
    var out = [];
    tiposUniformes(code).forEach(function (tipo, nombre) {
      if (GLOBAL_UNI.indexOf(nombre) === -1 && out.indexOf(nombre) === -1) out.push(nombre);
    });
    return out;
  }

  // `uniform bool` propios del shader: van con SWITCH en el panel (no slider).
  function boolSpecs(code) {
    var out = [];
    tiposUniformes(code).forEach(function (tipo, nombre) {
      if (tipo === 'bool' && GLOBAL_UNI.indexOf(nombre) === -1 && out.indexOf(nombre) === -1) out.push(nombre);
    });
    return out;
  }

  // Nombres de los uniforms que SÍ se mandan como valor (float + bool/int).
  // OJO: `uniformSpecs` ahora incluye los bool (antes sólo float) porque el
  // renderer necesita el valor de TODOS los custom uniforms; el panel decide
  // si lo dibuja como slider (float) o como switch (bool).
  function tipoDeUniform(code, nombre) {
    var t = tiposUniformes(code).get(nombre);
    return t || 'float';
  }

  function otherUniforms(code) {
    var out = [], re = /uniform\s+(vec2|vec3|vec4|sampler2D)\s+(\w+)\s*;/g, m;
    while ((m = re.exec(code || '')) !== null) {
      var n = m[2];
      if (GLOBAL_UNI.indexOf(n) !== -1 || /^iChannel\d$/.test(n) || /^imageInput/.test(n)) continue;
      if (!out.some(function (o) { return o.name === n; })) out.push({ name: n, type: m[1] });
    }
    return out;
  }

  // samplers propios del shader (los que se aliasan a la entrada conectada)
  function samplerAliases(code) {
    var out = [], re = /uniform\s+sampler2D\s+(\w+)\s*;/g, m;
    while ((m = re.exec(code || '')) !== null) {
      var n = m[1];
      if (/^iChannel\d$/.test(n) || /^imageInput/.test(n)) continue;
      if (GLOBAL_UNI.indexOf(n) !== -1) continue;
      if (out.indexOf(n) === -1) out.push(n);
    }
    return out;
  }

  // ---------------------------------------------------------------- inlets
  // TRADUCCIÓN ÚNICA de un inlet del nodeeditor a la entrada que espera el renderer.
  // La usan el plan del backend (/api/include/plan) Y el render de fondo del nodeeditor:
  // si cada uno la hace por su cuenta, el FEEDBACK ('self' = iChannelN lee el frame
  // ANTERIOR de la misma caja) anda en uno y no en el otro. Ese era exactamente el bug
  // de estrellasamarillas (no acumulaba) y de las páginas embebidas.
  //   'node:<uid>' -> buffer de esa caja           'self' -> su propio frame anterior
  //   'textureN'   -> imagen de entrada N          'none' -> nada
  function inletInput(conn, uid, urlImagen) {
    var c = String(conn == null ? 'none' : conn);
    if (c.indexOf('node:') === 0) return { type: 'buffer', id: c.slice(5) };
    if (c === 'self') return { type: 'self', id: uid };
    var m = /^texture(\d)$/.exec(c);
    if (m) {
      var url = urlImagen ? urlImagen(Number(m[1])) : '';
      if (url) return { type: 'texture_url', id: url };
    }
    return null;
  }

  // Primer inlet que trae una IMAGEN (otra caja o textureN): a ESE se aliasan los
  // samplers propios del shader (tex0, inputImage, …). El feedback ('self') NO es una
  // imagen de entrada, así que no reclama el alias.
  function inletPrimerImagen(connections) {
    var c = connections || [];
    for (var i = 0; i < SLOTS; i++) {
      var s = String(c[i] || 'none');
      if (s.indexOf('node:') === 0 || /^texture\d$/.test(s)) return i;
    }
    return -1;
  }

  function paramValue(box, name) {
    var p = (box.params || []).filter(function (x) { return x.name === name; })[0];
    var tipo = tipoDeUniform(box.code, name);
    // VECTOR (vec2/vec3/vec4): el valor es un ARRAY de componentes. Number(array) = NaN
    // y el plan quedaba con el default (0.5) — el shader perdía el vector elegido.
    var esVec = (tipo === 'vec2' || tipo === 'vec3' || tipo === 'vec4');
    if (esVec) {
      var n = tipo === 'vec2' ? 2 : (tipo === 'vec3' ? 3 : 4);
      var def = [0.5, 0.5, 0.5, 1].slice(0, n);
      var arr = p ? p.value : null;
      if (arr === undefined || arr === null) return def;
      if (typeof arr === 'number') {             // valor viejo guardado como número
        var solo = [];
        for (var k = 0; k < n; k++) solo.push(arr);
        return solo;
      }
      if (!Array.isArray(arr) && typeof arr.length !== 'number') return def;
      var out = [];
      for (var i = 0; i < n; i++) {
        var x = Number(arr[i]);
        out.push(isFinite(x) ? x : (i === 3 ? 1 : 0.5));
      }
      return out;
    }
    // Un `uniform bool` sin param creado vale 0 (false): devolver 0.5 lo mandaba
    // como TRUE al shader (0.5 es truthy) y el switch aparecía prendido de arranque.
    var esB = tipo === 'bool';
    if (!p) return esB ? 0 : 0.5;
    var v = Number(p.value);
    if (!Number.isFinite(v)) return esB ? 0 : 0.5;
    return (esB && v !== 0 && v !== 1) ? 0 : v;
  }

  // ---------------------------------------------------------------- GLSL
  // Arma el fuente completo de una caja: header de globales + (common) + código,
  // inyectando los iChannel conectados y el wrapper de mainImage.
  function buildNodeSource(box, commonBox) {
    var src = String(box.code || '');
    src = src.replace(/precision\s+\w+\s+float\s*;/g, '');
    // Los tests de declaración van sobre el fuente SIN comentarios (si no, un
    // comentario que mencione `uniform vec2 resolution;` lo deja sin declarar).
    var srcLimpio = JPPointers ? JPPointers.sinComentarios(src) : src;

    var header = 'precision highp float;\n';
    var decl = function (type, name, test) {
      var re = test || new RegExp('uniform\\s+' + type + '\\s+' + name + '\\b');
      if (!re.test(srcLimpio)) header += 'uniform ' + type + ' ' + name + ';\n';
    };
    decl('float', 'time');
    decl('vec4', 'mouse');
    decl('vec2', 'resolution');
    decl('float', 'fxrand');
    decl('int', 'iFrame');
    decl('float', 'BPM');
    // pointers (vec4[N] + count): la convención vive en js/lib/jp-pointers.js —
    // el check viejo (`/uniform\s+vec4\s+pointers/`) rompía todo shader que
    // declarara su propio array (vec2/vec3) con "'pointers': redefinition".
    if (JPPointers) header += JPPointers.headerDecls(src);

    // cada sampler2D de entrada conectada se declara solo
    for (var i = 0; i < SLOTS; i++) {
      var c = String((box.connections || [])[i] || '');
      if (c.indexOf('node:') !== 0) continue;
      if (!new RegExp('uniform\\s+sampler2D\\s+iChannel' + i + '\\b').test(src)) {
        header += 'uniform sampler2D iChannel' + i + ';\n';
      }
    }
    // el resto de los iChannel: declarados siempre (el renderer los cachea por nombre)
    for (var j = 0; j < SLOTS; j++) {
      if (!new RegExp('uniform\\s+sampler2D\\s+iChannel' + j + '\\b').test(src) &&
          header.indexOf('uniform sampler2D iChannel' + j + ';') === -1) {
        header += 'uniform sampler2D iChannel' + j + ';\n';
      }
    }

    header += '#define iTime time\n#define iGlobalTime time\n#define iResolution vec3(resolution, 1.0)\n' +
              '#define iMouse mouse\n';

    var common = (commonBox && commonBox.uid !== box.uid && commonBox.code)
      ? String(commonBox.code).replace(/precision\s+\w+\s+float\s*;/g, '') + '\n' : '';

    var full = header + common + src;

    if (/mainImage/.test(full) && !/void\s+main\s*\(\s*\)/.test(full)) {
      full += '\nvoid main() { mainImage(gl_FragColor, gl_FragCoord.xy); }\n';
    }
    return full;
  }

  // productores antes que consumidores, y la caja ACTIVA al final
  function topoOrder(boxes, active, root, onlyChain) {
    var seen = {}, out = [];
    var visit = function (uid) {
      if (seen[uid]) return;
      seen[uid] = 1;
      var b = boxes.filter(function (x) { return x.uid === uid; })[0];
      if (!b) return;
      (b.connections || []).forEach(function (c) {
        if (String(c).indexOf('node:') === 0) visit(String(c).slice(5));
      });
      out.push(uid);
    };
    var act = root || active;
    if (onlyChain) {
      if (act) visit(act);
    } else {
      boxes.forEach(function (b) { if (b.uid !== act) visit(b.uid); });
      if (act) visit(act);
    }
    if (act && out.indexOf(act) !== -1) {
      out.splice(out.indexOf(act), 1);
      out.push(act);
    }
    return out;
  }

  // ---------------------------------------------------------------- normalizar
  function normalizeBox(b) {
    var conns = (Array.isArray(b.connections) && b.connections.length === SLOTS)
      ? b.connections.map(function (c) { return String(c || 'none'); })
      : ['none', 'none', 'none', 'none'];
    return {
      uid: String(b.uid),
      nombre: b.nombre || String(b.uid),
      type: b.type || 'shader',
      shader: b.shader || '',
      code: b.code || '',
      params: Array.isArray(b.params) ? b.params : [],
      connections: conns
    };
  }

  /* ----------------------------------------------------------------
     buildRenderPlan(doc, opts) → plan 100% resuelto, listo para WebGL.

     doc  = documento de composición tal como lo guarda el nodeeditor
     opts = { pass }  → uid de la caja que se ve de fondo (si falta: doc.output)

     Devuelve:
       { ok, comp, titulo, autor, updatedAt, pass, order[], displayPassId,
         passes:[{ id, name, type, shader, source, inputs[], aliases{}, uniforms{} }] }
     `source` ya es el GLSL FINAL (header + common + wrapper mainImage).
     Las cajas `common` NO generan pase: sólo se anteponen al resto.
     ---------------------------------------------------------------- */
  function buildRenderPlan(doc, opts) {
    opts = opts || {};
    var raw = (doc && Array.isArray(doc.boxes)) ? doc.boxes : [];
    var boxes = raw.filter(function (b) { return b && (b.uid !== undefined && b.uid !== null); })
                   .map(normalizeBox);
    if (!boxes.length) return { ok: false, error: 'La composición no tiene nodos' };

    var common = boxes.filter(function (b) { return b.type === 'common'; })[0] || null;
    var renderables = boxes.filter(function (b) { return b.type !== 'common'; });
    if (!renderables.length) return { ok: false, error: 'La composición no tiene cajas renderizables' };

    var wantPass = opts.pass ? String(opts.pass) : '';
    var have = function (uid) { return renderables.some(function (b) { return b.uid === uid; }); };
    var passUid = (wantPass && have(wantPass)) ? wantPass
                : (doc && doc.output && have(String(doc.output))) ? String(doc.output)
                : renderables[0].uid;

    // el orden se calcula sobre TODAS las cajas (una common puede alimentar por código)
    var order = topoOrder(boxes, passUid, passUid, false)
      .filter(function (id) { return have(id); });

    var urlImagen = typeof opts.urlImagen === 'function' ? opts.urlImagen : null;

    var passes = renderables.map(function (b) {
      var slotCon = inletPrimerImagen(b.connections);
      var aliases = {};
      if (slotCon >= 0) samplerAliases(b.code).forEach(function (n) { aliases[n] = slotCon; });

      var uniforms = {};
      uniformSpecs(b.code).forEach(function (n) { uniforms[n] = paramValue(b, n); });
      otherUniforms(b.code).forEach(function (o) { if (uniforms[o.name] === undefined) uniforms[o.name] = paramValue(b, o.name); });

      // Misma traducción de inlets que el render de fondo del nodeeditor (ver inletInput):
      // acá es donde el backend resuelve el plan del include embebible.
      var inputs = [];
      for (var i = 0; i < SLOTS; i++) {
        if (b.type === 'camera' && i === 0) { inputs.push({ type: 'texture_url', id: '__jp_camera__' }); continue; }
        inputs.push(inletInput((b.connections || [])[i], b.uid, urlImagen));
      }

      var params = (b.params || []).map(function (p) {
        return { name: p.name, value: p.value, min: p.min, max: p.max, step: p.step, label: p.label || p.name };
      });

      return {
        id: b.uid, name: b.nombre, type: b.type, shader: b.shader,
        source: buildNodeSource(b, common),
        inputs: inputs,
        aliases: aliases,
        uniforms: uniforms,
        params: params
      };
    });

    return {
      ok: true,
      comp: doc.nombre || '',
      titulo: doc.titulo || doc.nombre || '',
      autor: doc.autor || '',
      updatedAt: String(doc.fechaActualizacion || doc.fechaCreacion || ''),
      pass: passUid,
      order: order,
      displayPassId: passUid,
      hasCamera: renderables.some(function (b) { return b.type === 'camera'; }),
      passes: passes
    };
  }

  return {
    SLOTS: SLOTS,
    VERTEX: VERTEX,
    GLOBAL_UNI: GLOBAL_UNI,
    uniformSpecs: uniformSpecs,
    boolSpecs: boolSpecs,
    tipoDeUniform: tipoDeUniform,
    otherUniforms: otherUniforms,
    samplerAliases: samplerAliases,
    inletInput: inletInput,
    inletPrimerImagen: inletPrimerImagen,
    paramValue: paramValue,
    buildNodeSource: buildNodeSource,
    topoOrder: topoOrder,
    normalizeBox: normalizeBox,
    buildRenderPlan: buildRenderPlan
  };
});
