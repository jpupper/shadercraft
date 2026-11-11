/**
 * Configuración Universal de Entorno (Local vs Producción Dual-Hosting FSC)
 */
(function () {
    const isLocalHost = /^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)$/i.test(window.location.hostname);
    const localOrigin = window.location.port
        ? `${window.location.protocol}//${window.location.hostname}:${window.location.port}`
        : 'http://localhost:3255';
    const vpsOrigin = 'https://vps-4455523-x.dattaweb.com';

    const backendOrigin = isLocalHost ? localOrigin : vpsOrigin;

    window.CONFIG = {
        IS_LOCAL: isLocalHost,
        BASE_PATH: '/shadercraft',
        BACKEND_ORIGIN: backendOrigin,
        API_URL: `${backendOrigin}/shadercraft/api`,
        SOCKET_ORIGIN: backendOrigin,
        SOCKET_PATH: '/shadercraft/socket.io',
        JPSHADER_VPS: 'https://vps-4455523-x.dattaweb.com/jpshadereditor',
        JPSHADER_LOCAL: 'http://localhost:3250/jpshadereditor'
    };
})();

