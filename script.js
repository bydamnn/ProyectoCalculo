// ==========================================
// 1. UTILIDADES Y CONFIGURACIÓN INICIAL
// ==========================================

// Obtiene un elemento del HTML por su ID de forma abreviada
const obtenerElemento = (id) => document.getElementById(id);

// Formatea un número decimal a una cantidad fija de decimales
const formatearNumero = (valor, decimales = 1) => valor.toFixed(decimales);

// Factor de escala vertical para el terreno en 3D
const ESCALA_VERTICAL = 5 / 1000;

// Definición de las 6 montañas/colinas gaussianas: [centroX, centroY, alturaAmplitud, dispersion]
const COLINAS_GAUSSIANAS = [
    [2.5, 7, 900, 1.5],
    [7.5, 6.5, 650, 1.3],
    [5, 2.5, 500, 1.8],
    [5, 5.5, -350, 1.1],  // Depresión / Valle
    [8, 2, -250, 1],       // Depresión / Valle
    [1.8, 2.5, -200, 1]    // Depresión / Valle
];

// ==========================================
// 2. MODELO MATEMÁTICO DEL TERRENO
// ==========================================

/**
 * Calcula la altura (h) y las derivadas (pendientes en X e Y, curvaturas) 
 * en cualquier punto (x, y) del mapa usando la superposición de campanas de Gauss.
 */
function calcularTerreno(x, y) {
    let alturaBase = 400;
    let derivadaX = 0, derivadaY = 0;
    let derivadaXX = 0, derivadaYY = 0, derivadaXY = 0;

    for (const [centroX, centroY, amplitud, desviacion] of COLINAS_GAUSSIANAS) {
        const distanciaX = x - centroX;
        const distanciaY = y - centroY;
        const varianza = desviacion * desviacion;

        // Ecuación de la campana gaussiana para relieve suave
        const gaussiana = amplitud * Math.exp(-(distanciaX * distanciaX + distanciaY * distanciaY) / (2 * varianza));

        alturaBase += gaussiana;
        derivadaX -= gaussiana * distanciaX / varianza;
        derivadaY -= gaussiana * distanciaY / varianza;
        derivadaXX += gaussiana * (distanciaX * distanciaX / varianza / varianza - 1 / varianza);
        derivadaYY += gaussiana * (distanciaY * distanciaY / varianza / varianza - 1 / varianza);
        derivadaXY += gaussiana * distanciaX * distanciaY / varianza / varianza;
    }

    return { h: alturaBase, gx: derivadaX, gy: derivadaY, xx: derivadaXX, yy: derivadaYY, xy: derivadaXY };
}

// Convierte coordenadas de mapa (x, y) a coordenadas tridimensionales [X, Y, Z] para la cámara
const convertir3D = (x, y, elevacionExtra = 0.04) => [x - 5, calcularTerreno(x, y).h * ESCALA_VERTICAL + elevacionExtra, 5 - y];

// Paleta de colores para los puntos interactivos del mapa
const COLORES_PUNTOS = { P: '#ff4d6d', A: '#22d3a0', B: '#7c8cff', C: '#f5b84b' };

// Posiciones iniciales de los puntos de interés en el mapa
const POSICIONES_PUNTOS = {
    P: { x: 3.6, y: 5.2 },
    A: { x: 3.2, y: 4.2 },
    B: { x: 7.2, y: 3.2 },
    C: { x: 6, y: 8.2 }
};

let puntoActivo = 'P';
let modoVisualizacion = 'h'; // 'h' para altura, 's' para pendiente
let puntosCriticos = [];
let depresionesMinimas = [];
let alturaCorteCuenca = 400;
let porcentajesCuencas = [];

// ==========================================
// 3. MALLA Y ESTRUCTURAS DE DATOS 3D
// ==========================================

const RESOLUCION_MALLA = 64;
const VERTICES_POR_LADO = RESOLUCION_MALLA + 1;
const TOTAL_VERTICES = VERTICES_POR_LADO * VERTICES_POR_LADO;

// Buffers de rendimiento para optimizar los cálculos gráficos en JavaScript
const MESH_X = new Float32Array(TOTAL_VERTICES);
const MESH_Y = new Float32Array(TOTAL_VERTICES);
const MESH_Z = new Float32Array(TOTAL_VERTICES);
const ALTURAS_MALLA = new Float32Array(TOTAL_VERTICES);
const PENDIENTES_MALLA = new Float32Array(TOTAL_VERTICES);
const PROYECCION_X = new Float32Array(TOTAL_VERTICES);
const PROYECCION_Y = new Float32Array(TOTAL_VERTICES);
const PROYECCION_Z = new Float32Array(TOTAL_VERTICES);
const COLORES_MALLA = new Float32Array(TOTAL_VERTICES * 3);
const SOMBRAS_CUADRADOS = new Float32Array(RESOLUCION_MALLA * RESOLUCION_MALLA);

let cacheCuadrados = [];
let ordenRenderizado = [];
let rutaPuntoP = [];
let rutaA_B = [];
let rutaA_C_B = [];
let lineasLluvia = [];

// Parámetros de la cámara virtual 3D
let anguloAzimut = 0.6;
let anguloElevacion = 0.8;
let distanciaCamara = 17;
let anchoCanvas = 600;
let altoCanvas = 450;
let funcionProyeccionActual = null;
let factorFocal = 500;

const canvas = obtenerElemento('cv');
const contextoGrafico = canvas.getContext('2d');

/**
 * Simula el recorrido del agua bajando por la pendiente (líneas de flujo)
 */
function calcularFlujoAgua(x, y, paso = 0.03, maxPasos = 1500) {
    const trayectoria = [{ x, y }];
    for (let i = 0; i < maxPasos; i++) {
        const terreno = calcularTerreno(x, y);
        const magnitudGradiente = Math.hypot(terreno.gx, terreno.gy);
        if (magnitudGradiente < 2) break;

        const nuevoX = x - terreno.gx / magnitudGradiente * paso;
        const nuevoY = y - terreno.gy / magnitudGradiente * paso;

        if (nuevoX < 0 || nuevoX > 10 || nuevoY < 0 || nuevoY > 10 || calcularTerreno(nuevoX, nuevoY).h > terreno.h) break;
        x = nuevoX; y = nuevoY;
        trayectoria.push({ x, y });
    }
    return trayectoria;
}

// Rangos de colores para alturas y pendientes
const TABLA_ALTURAS = [[28, 95, 125], [60, 150, 95], [196, 176, 104], [150, 108, 78], [246, 246, 246]];
const TABLA_PENDIENTES = [[.2, .75, .4], [.95, .85, .3], [.95, .35, .25], [.55, .05, .15]];

function pintarTerreno() {
    for (let k = 0; k < TOTAL_VERTICES; k++) {
        let colorRGB;
        if (modoVisualizacion == 'h') {
            const normalizado = Math.min(.999, Math.max(0, (ALTURAS_MALLA[k] - 60) / 1250)) * 4;
            const indice = Math.floor(normalizado), fraccion = normalizado - indice;
            colorRGB = TABLA_ALTURAS[indice].map((val, m) => val + (TABLA_ALTURAS[indice + 1][m] - val) * fraccion);
        } else {
            const normalizado = Math.min(.999, PENDIENTES_MALLA[k] / 45) * 3;
            const indice = Math.floor(normalizado), fraccion = normalizado - indice;
            colorRGB = TABLA_PENDIENTES[indice].map((val, m) => (val + (TABLA_PENDIENTES[indice + 1][m] - val) * fraccion) * 255);
        }
        COLORES_MALLA.set(colorRGB, k * 3);
    }

    cacheCuadrados = [];
    for (let j = 0; j < RESOLUCION_MALLA; j++) {
        for (let i = 0; i < RESOLUCION_MALLA; i++) {
            const k = j * VERTICES_POR_LADO + i;
            const factorLuz = SOMBRAS_CUADRADOS[j * RESOLUCION_MALLA + i];
            const colorFinal = [0, 1, 2].map(m => Math.round((COLORES_MALLA[k * 3 + m] + COLORES_MALLA[(k + 1) * 3 + m] + COLORES_MALLA[(k + VERTICES_POR_LADO) * 3 + m] + COLORES_MALLA[(k + VERTICES_POR_LADO + 1) * 3 + m]) / 4 * factorLuz));
            cacheCuadrados.push(`rgb(${colorFinal})`);
        }
    }
}

/**
 * Construye la malla 3D completa, calcula iluminación y detecta puntos críticos (cimas, valles, sillas)
 */
function construirTerreno() {
    for (let j = 0; j <= RESOLUCION_MALLA; j++) {
        for (let i = 0; i <= RESOLUCION_MALLA; i++) {
            const x = i / RESOLUCION_MALLA * 10;
            const y = j / RESOLUCION_MALLA * 10;
            const terreno = calcularTerreno(x, y);
            const k = j * VERTICES_POR_LADO + i;

            MESH_X[k] = x - 5;
            MESH_Y[k] = terreno.h * ESCALA_VERTICAL;
            MESH_Z[k] = 5 - y;
            ALTURAS_MALLA[k] = terreno.h;
            PENDIENTES_MALLA[k] = Math.hypot(terreno.gx, terreno.gy) / 10;
        }
    }

    const VectorLuz = [-.5, .8, .4];
    const longitudLuz = Math.hypot(...VectorLuz);

    for (let j = 0; j < RESOLUCION_MALLA; j++) {
        for (let i = 0; i < RESOLUCION_MALLA; i++) {
            const k = j * VERTICES_POR_LADO + i;
            const vectorA = [MESH_X[k + 1] - MESH_X[k], MESH_Y[k + 1] - MESH_Y[k], MESH_Z[k + 1] - MESH_Z[k]];
            const vectorB = [MESH_X[k + VERTICES_POR_LADO] - MESH_X[k], MESH_Y[k + VERTICES_POR_LADO] - MESH_Y[k], MESH_Z[k + VERTICES_POR_LADO] - MESH_Z[k]];

            // Producto cruz para calcular el vector normal de la superficie (iluminación)
            const normalX = vectorA[1] * vectorB[2] - vectorA[2] * vectorB[1];
            const normalY = vectorA[2] * vectorB[0] - vectorA[0] * vectorB[2];
            const normalZ = vectorA[0] * vectorB[1] - vectorA[1] * vectorB[0];

            SOMBRAS_CUADRADOS[j * RESOLUCION_MALLA + i] = .4 + .6 * Math.max(0, (normalX * VectorLuz[0] + normalY * VectorLuz[1] + normalZ * VectorLuz[2]) / Math.hypot(normalX, normalY, normalZ) / longitudLuz);
        }
    }

    pintarTerreno();

    // Búsqueda de puntos críticos (Cimas, Depresiones, Puntos de Silla) usando optimización de Newton
    puntosCriticos = [];
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 10; j++) {
            let x = .5 + i, y = .5 + j, esValido = false;
            for (let k = 0; k < 50; k++) {
                const terreno = calcularTerreno(x, y);
                const determinanteHessiano = terreno.xx * terreno.yy - terreno.xy ** 2;
                if (Math.abs(determinanteHessiano) < 1e-6) break;

                let deltaX = (terreno.yy * terreno.gx - terreno.xy * terreno.gy) / determinanteHessiano;
                let deltaY = (-terreno.xy * terreno.gx + terreno.xx * terreno.gy) / determinanteHessiano;
                const longitudPaso = Math.hypot(deltaX, deltaY);

                if (longitudPaso > .5) { deltaX *= .5 / longitudPaso; deltaY *= .5 / longitudPaso; }
                x -= deltaX; y -= deltaY;

                if (x < 0 || x > 10 || y < 0 || y > 10) break;
                if (Math.hypot(terreno.gx, terreno.gy) < 1e-5) { esValido = true; break; }
            }
            if (esValido && !puntosCriticos.some(c => Math.hypot(c.x - x, c.y - y) < .15)) {
                const terreno = calcularTerreno(x, y);
                const determinanteHessiano = terreno.xx * terreno.yy - terreno.xy ** 2;
                puntosCriticos.push({ x, y, h: terreno.h, D: determinanteHessiano, k: determinanteHessiano < 0 ? 'S' : terreno.xx < 0 ? 'P' : 'M' });
            }
        }
    }

    depresionesMinimas = puntosCriticos.filter(c => c.k == 'M').sort((a, b) => a.x - b.x);
    alturaCorteCuenca = (depresionesMinimas.length ? Math.min(...depresionesMinimas.map(c => c.h)) : 400) + 80;

    // Cálculo de cuencas de captación de agua por simulación de lluvia en malla 14x14
    const conteoCuencas = new Array(depresionesMinimas.length + 1).fill(0);
    let totalGotas = 0;
    lineasLluvia = [];

    for (let i = 0; i < 14; i++) {
        for (let j = 0; j < 14; j++) {
            const trayectoria = calcularFlujoAgua(.35 + i * .7, .35 + j * .7, .04, 1200);
            const puntoFinal = trayectoria[trayectoria.length - 1];
            let mejorDepresion = -1, distanciaMinima = .6;

            depresionesMinimas.forEach((minima, k) => {
                const distancia = Math.hypot(minima.x - puntoFinal.x, minima.y - puntoFinal.y);
                if (distancia < distanciaMinima) { distanciaMinima = distancia; mejorDepresion = k; }
            });

            conteoCuencas[mejorDepresion < 0 ? depresionesMinimas.length : mejorDepresion]++;
            totalGotas++;
            lineasLluvia.push(trayectoria.filter((_, k) => k % 3 == 0).map(q => convertir3D(q.x, q.y, .05)));
        }
    }
    porcentajesCuencas = conteoCuencas.map(conteo => conteo / totalGotas * 100);
}

// ==========================================
// 4. RENDERIZADO GRÁFICO 3D EN CANVAS
// ==========================================

function renderizarEscena() {
    const DistanciaFocal = altoCanvas * 1.15;
    const camaraX = distanciaCamara * Math.cos(anguloElevacion) * Math.sin(anguloAzimut);
    const camaraY = 1 + distanciaCamara * Math.sin(anguloElevacion);
    const camaraZ = distanciaCamara * Math.cos(anguloElevacion) * Math.cos(anguloAzimut);

    let vectorFrente = [-camaraX, 1 - camaraY, -camaraZ];
    const longitudFrente = Math.hypot(...vectorFrente);
    vectorFrente = vectorFrente.map(v => v / longitudFrente);

    let vectorDerecha = [-vectorFrente[2], 0, vectorFrente[0]];
    const longitudDerecha = Math.hypot(...vectorDerecha);
    vectorDerecha = vectorDerecha.map(v => v / longitudDerecha);

    let vectorArriba = [
        vectorDerecha[1] * vectorFrente[2] - vectorDerecha[2] * vectorFrente[1],
        vectorDerecha[2] * vectorFrente[0] - vectorDerecha[0] * vectorFrente[2],
        vectorDerecha[0] * vectorFrente[1] - vectorDerecha[1] * vectorFrente[0]
    ];

    const proyectarPunto = punto => {
        const deltaX = punto[0] - camaraX, deltaY = punto[1] - camaraY, deltaZ = punto[2] - camaraZ;
        const profundidadZ = deltaX * vectorFrente[0] + deltaY * vectorFrente[1] + deltaZ * vectorFrente[2];
        if (profundidadZ < .3) return null;
        return [
            anchoCanvas / 2 + (deltaX * vectorDerecha[0] + deltaY * vectorDerecha[1] + deltaZ * vectorDerecha[2]) / profundidadZ * DistanciaFocal,
            altoCanvas / 2 - (deltaX * vectorArriba[0] + deltaY * vectorArriba[1] + deltaZ * vectorArriba[2]) / profundidadZ * DistanciaFocal,
            profundidadZ
        ];
    };

    funcionProyeccionActual = proyectarPunto;
    ricFocal = DistanciaFocal;

    contextoGrafico.fillStyle = '#0d1428';
    contextoGrafico.fillRect(0, 0, anchoCanvas, altoCanvas);

    for (let k = 0; k < TOTAL_VERTICES; k++) {
        const q = proyectarPunto([MESH_X[k], MESH_Y[k], MESH_Z[k]]);
        if (q) { PROYECCION_X[k] = q[0]; PROYECCION_Y[k] = q[1]; PROYECCION_Z[k] = q[2]; }
        else PROYECCION_Z[k] = -1;
    }

    ordenRenderizado = [];
    const indicesJ = [...Array(RESOLUCION_MALLA).keys()], indicesI = [...Array(RESOLUCION_MALLA).keys()];
    if (camaraX <= 0) indicesI.reverse();
    if (camaraZ > 0) indicesJ.reverse();

    contextoGrafico.lineWidth = .7;
    for (const j of indicesJ) {
        for (const i of indicesI) {
            const k = j * VERTICES_POR_LADO + i, k1 = k + 1, k2 = k + VERTICES_POR_LADO, k3 = k2 + 1;
            if (PROYECCION_Z[k] < 0 || PROYECCION_Z[k1] < 0 || PROYECCION_Z[k2] < 0 || PROYECCION_Z[k3] < 0) continue;

            const colorHex = cacheCuadrados[j * RESOLUCION_MALLA + i];
            contextoGrafico.fillStyle = colorHex;
            contextoGrafico.strokeStyle = colorHex;
            contextoGrafico.beginPath();
            contextoGrafico.moveTo(PROYECCION_X[k], PROYECCION_Y[k]);
            contextoGrafico.lineTo(PROYECCION_X[k1], PROYECCION_Y[k1]);
            contextoGrafico.lineTo(PROYECCION_X[k3], PROYECCION_Y[k3]);
            contextoGrafico.lineTo(PROYECCION_X[k2], PROYECCION_Y[k2]);
            contextoGrafico.closePath();
            contextoGrafico.fill();
            contextoGrafico.stroke();
            ordenRenderizado.push(j * RESOLUCION_MALLA + i);
        }
    }

    const dibujarPoligona = (puntos, colorHex, grosorLinea) => {
        contextoGrafico.strokeStyle = colorHex;
        contextoGrafico.lineWidth = grosorLinea;
        contextoGrafico.beginPath();
        let dibujando = false;
        for (const p of puntos) {
            const q = proyectarPunto(p);
            if (!q) { dibujando = false; continue; }
            dibujando ? contextoGrafico.lineTo(q[0], q[1]) : contextoGrafico.moveTo(q[0], q[1]);
            dibujando = true;
        }
        contextoGrafico.stroke();
    };

    // Dibuja líneas de lluvia si el checkbox está activo
    if (obtenerElemento('kl').checked) {
        contextoGrafico.globalAlpha = .6;
        contextoGrafico.strokeStyle = '#50c8ff';
        contextoGrafico.lineWidth = 1.2;
        contextoGrafico.beginPath();
        for (const trayectoria of lineasLluvia) {
            let dibujando = false;
            for (const punto of trayectoria) {
                const q = proyectarPunto(punto);
                if (!q) { dibujando = false; continue; }
                dibujando ? contextoGrafico.lineTo(q[0], q[1]) : contextoGrafico.moveTo(q[0], q[1]);
                dibujando = true;
            }
        }
        contextoGrafico.stroke();
        contextoGrafico.globalAlpha = 1;
    }

    // Dibuja rutas y caminos
    dibujarPoligona(rutaA_B, '#4cc9f0', 3);
    dibujarPoligona(rutaA_C_B, '#ffb020', 3);
    dibujarPoligona(rutaPuntoP, '#ffffff', 3);

    // Dibuja marcadores de puntos notables (Cimas, Valles, Puntos A, B, C, P)
    const dibujarMarcadorPunto = (p, radio, colorHex, etiqueta) => {
        const q = proyectarPunto(p);
        if (!q) return;
        const radioPantalla = Math.max(3, radio * DistanciaFocal / q[2]);
        contextoGrafico.fillStyle = colorHex;
        contextoGrafico.strokeStyle = '#000';
        contextoGrafico.lineWidth = 2;
        contextoGrafico.beginPath();
        contextoGrafico.arc(q[0], q[1], radioPantalla, 0, 7);
        contextoGrafico.fill();
        contextoGrafico.stroke();
        if (etiqueta) {
            contextoGrafico.fillStyle = '#fff';
            contextoGrafico.font = 'bold 13px sans-serif';
            contextoGrafico.fillText(etiqueta, q[0] + radioPantalla + 3, q[1] - radioPantalla);
        }
    };

    if (obtenerElemento('kc').checked) {
        puntosCriticos.forEach(c => dibujarMarcadorPunto(convertir3D(c.x, c.y, .12), .12, c.k == 'P' ? '#fff' : c.k == 'M' ? '#4cc9f0' : '#f5b84b'));
    }

    for (const clave of ['A', 'B', 'C', 'P']) {
        dibujarMarcadorPunto(convertir3D(POSICIONES_PUNTOS[clave].x, POSICIONES_PUNTOS[clave].y, .2), clave == 'P' ? .2 : .17, COLORES_PUNTOS[clave], clave == 'P' ? 'P' : clave);
    }
}

let pendienteRedibujo = false;
function solicitarRenderizado() {
    if (pendienteRedibujo) return;
    pendienteRedibujo = true;
    requestAnimationFrame(() => { pendienteRedibujo = false; renderizarEscena(); });
}

// ==========================================
// 5. INTERACCIÓN Y GESTIÓN DE EVENTOS
// ==========================================

function ajustarDimensionesCanvas() {
    const contenedorVisual = obtenerElemento('v'), densidadPixeles = devicePixelRatio || 1;
    anchoCanvas = contenedorVisual.clientWidth;
    altoCanvas = contenedorVisual.clientHeight;
    canvas.width = anchoCanvas * densidadPixeles;
    canvas.height = altoCanvas * densidadPixeles;
    contextoGrafico.setTransform(densidadPixeles, 0, 0, densidadPixeles, 0, 0);
    renderizarEscena();
}

// Coordenadas baricéntricas para detectar clics precisos sobre los triángulos de la malla
const calcularBaricentricas = (px, py, a, b, c) => {
    const determinante = (PROYECCION_Y[b] - PROYECCION_Y[c]) * (PROYECCION_X[a] - PROYECCION_X[c]) + (PROYECCION_X[c] - PROYECCION_X[b]) * (PROYECCION_Y[a] - PROYECCION_Y[c]);
    if (!determinante) return null;
    const l1 = ((PROYECCION_Y[b] - PROYECCION_Y[c]) * (px - PROYECCION_X[c]) + (PROYECCION_X[c] - PROYECCION_X[b]) * (py - PROYECCION_Y[c])) / determinante;
    const l2 = ((PROYECCION_Y[c] - PROYECCION_Y[a]) * (px - PROYECCION_X[c]) + (PROYECCION_X[a] - PROYECCION_X[c]) * (py - PROYECCION_Y[c])) / determinante;
    const l3 = 1 - l1 - l2;
    return l1 >= 0 && l2 >= 0 && l3 >= 0 ? [l1, l2, l3] : null;
};

function detectarPuntoEnTerreno(px, py) {
    for (let n = ordenRenderizado.length - 1; n >= 0; n--) {
        const q = ordenRenderizado[n], i = q % RESOLUCION_MALLA, j = (q / RESOLUCION_MALLA) | 0;
        const k = j * VERTICES_POR_LADO + i, k1 = k + 1, k2 = k + VERTICES_POR_LADO, k3 = k2 + 1;
        const pesos = calcularBaricentricas(px, py, k, k1, k3);
        let ids = [k, k1, k3], baricentricas = pesos;
        if (!pesos) {
            baricentricas = calcularBaricentricas(px, py, k, k3, k2);
            ids = [k, k3, k2];
        }
        if (baricentricas) {
            let x = 0, y = 0;
            ids.forEach((id, m) => { x += baricentricas[m] * (MESH_X[id] + 5); y += baricentricas[m] * (5 - MESH_Z[id]); });
            return { x, y };
        }
    }
    return null;
}

let datosArrastre = null;
canvas.onpointerdown = evento => {
    datosArrastre = { x: evento.clientX, y: evento.clientY, movimientoTotal: 0 };
    canvas.setPointerCapture(evento.pointerId);
    canvas.style.cursor = 'grabbing';
};

canvas.onpointermove = evento => {
    if (!datosArrastre) return;
    const deltaX = evento.clientX - datosArrastre.x, deltaY = evento.clientY - datosArrastre.y;
    datosArrastre.movimientoTotal += Math.abs(deltaX) + Math.abs(deltaY);
    anguloAzimut -= deltaX * .007;
    anguloElevacion = Math.min(1.5, Math.max(.15, anguloElevacion + deltaY * .007));
    datosArrastre.x = evento.clientX; datosArrastre.y = evento.clientY;
    solicitarRenderizado();
};

canvas.onpointerup = evento => {
    canvas.style.cursor = 'grab';
    if (datosArrastre && datosArrastre.movimientoTotal < 6) {
        const rectangulo = canvas.getBoundingClientRect();
        const coordenadasClic = detectarPuntoEnTerreno(evento.clientX - rectangulo.left, evento.clientY - rectangulo.top);
        if (coordenadasClic) {
            POSICIONES_PUNTOS[puntoActivo] = coordenadasClic;
            actualizarPanelesInterfaz();
        }
    }
    datosArrastre = null;
};

canvas.addEventListener('wheel', evento => {
    evento.preventDefault();
    distanciaCamara = Math.min(30, Math.max(6, distanciaCamara + evento.deltaY * .01));
    solicitarRenderizado();
}, { passive: false });

// ==========================================
// 6. ANÁLISIS DE RUTAS Y MÉTRICAS
// ==========================================

function analizarMetricasRuta(puntosSegmento) {
    const puntos3D = [];
    let longitudTotal = 0, pendienteMaxima = 0, sumaPendientes = 0, contadorPuntos = 0, gananciaElevacion = 0, porcentajeMalaPendiente = 0, alturaAnterior = null;

    for (let k = 0; k < puntosSegmento.length - 1; k++) {
        const puntoA = puntosSegmento[k], puntoB = puntosSegmento[k + 1];
        const deltaX = puntoB.x - puntoA.x, deltaY = puntoB.y - puntoA.y;
        const distanciaSegmento = Math.hypot(deltaX, deltaY) || 1e-9;

        for (let i = 0; i <= 120; i++) {
            const x = puntoA.x + deltaX * i / 120, y = puntoA.y + deltaY * i / 120;
            const terreno = calcularTerreno(x, y);
            const pendienteActual = Math.abs((terreno.gx * deltaX + terreno.gy * deltaY) / distanciaSegmento) / 10;

            puntos3D.push(convertir3D(x, y, .06));
            pendienteMaxima = Math.max(pendienteMaxima, pendienteActual);
            sumaPendientes += pendienteActual;
            contadorPuntos++;

            if (pendienteActual > 12) porcentajeMalaPendiente++;
            if (alturaAnterior !== null) {
                longitudTotal += Math.hypot(distanciaSegmento / 120, (terreno.h - alturaAnterior) / 1000);
                if (terreno.h > alturaAnterior) gananciaElevacion += terreno.h - alturaAnterior;
            }
            alturaAnterior = terreno.h;
        }
    }
    return { pts: puntos3D, L: longitudTotal, mx: pendienteMaxima, mean: sumaPendientes / contadorPuntos, cl: gananciaElevacion, bad: porcentajeMalaPendiente / contadorPuntos * 100 };
}

const formatearCientifico = valor => valor.toExponential(1);
const evaluarPuntoAnalisis = punto => {
    const terreno = calcularTerreno(punto.x, punto.y), pendiente = Math.hypot(terreno.gx, terreno.gy) / 10;
    return { t: terreno, s: pendiente, i: 100 * Math.exp(-((pendiente / 20) ** 2)) * (terreno.h >= alturaCorteCuenca ? 1 : .4) };
};

function determinarDestinoFlujo(punto) {
    let indiceDepresion = -1, distanciaMinima = .6;
    depresionesMinimas.forEach((minima, k) => {
        const distancia = Math.hypot(minima.x - punto.x, minima.y - punto.y);
        if (distancia < distanciaMinima) { distanciaMinima = distancia; indiceDepresion = k; }
    });
    return indiceDepresion < 0 ? 'sale del dominio / sin depresión cercana' : `Depresión D${indiceDepresion + 1} (${Math.round(depresionesMinimas[indiceDepresion].h)} m)`;
}

// ==========================================
// 7. ACTUALIZACIÓN DE LA INTERFAZ Y PANELES
// ==========================================

const NOMBRES_RUMBO = ['este', 'noreste', 'norte', 'noroeste', 'oeste', 'suroeste', 'sur', 'sureste'];
const normalizarAngulo = g => ((g % 360) + 360) % 360;
const rumboEnPalabras = g => NOMBRES_RUMBO[Math.round(normalizarAngulo(g) / 45) % 8];
const verboCambio = v => v >= 0 ? 'sube' : 'baja';
const marcaOk = ok => ok ? '<span class="ok">✔ sí</span>' : '<span class="rd">✘ no</span>';

function describirInclinacion(pendientePct) {
    const p = Math.abs(pendientePct);
    if (p < 5) return 'casi plano';
    if (p < 15) return 'suave';
    if (p < 30) return 'inclinado';
    return 'muy empinado (zona de alerta)';
}

function actualizarPanelesInterfaz() {
    const f = formatearNumero;
    const nombre = puntoActivo;
    const { x, y } = POSICIONES_PUNTOS[puntoActivo];
    const terreno = calcularTerreno(x, y);

    // --- Magnitudes principales ---
    const gx = terreno.gx, gy = terreno.gy;
    const magnitudGradiente = Math.hypot(gx, gy);
    const pendienteMaxima = magnitudGradiente / 10;
    const casiPlano = magnitudGradiente < 2;
    const thetaGrados = Number(obtenerElemento('th').value);
    const theta = thetaGrados * Math.PI / 180;
    const ux = Math.cos(theta), uy = Math.sin(theta);
    const derivadaDireccional = gx * ux + gy * uy;
    const pendienteDireccional = derivadaDireccional / 10;
    const anguloGradiente = casiPlano ? 0 : normalizarAngulo(Math.atan2(gy, gx) * 180 / Math.PI);
    const anguloAgua = normalizarAngulo(anguloGradiente + 180);
    const anguloNivelA = normalizarAngulo(anguloGradiente + 90);
    const anguloNivelB = normalizarAngulo(anguloGradiente - 90);

    obtenerElemento('vth').textContent = thetaGrados + '°';

    // --- Verificación numérica (diferencias finitas). La comparación usa tolerancia RELATIVA ---
    const e1 = 1e-4, e2 = 1e-2;
    const dxF = (calcularTerreno(x + e1, y).h - calcularTerreno(x - e1, y).h) / (2 * e1);
    const dyF = (calcularTerreno(x, y + e1).h - calcularTerreno(x, y - e1).h) / (2 * e1);
    const dxxF = (calcularTerreno(x + e2, y).h - 2 * terreno.h + calcularTerreno(x - e2, y).h) / e2 ** 2;
    const duF = (calcularTerreno(x + e1 * ux, y + e1 * uy).h - calcularTerreno(x - e1 * ux, y - e1 * uy).h) / (2 * e1);
    const derivadaPerpendicular = -gx * uy + gy * ux;

    // ======================================================================
    // PANEL 1: explicación paso a paso del punto analizado
    // ======================================================================
    const textoGradiente = casiPlano
        ? `<p>Aquí el gradiente es casi cero (|∇h| = ${f(magnitudGradiente, 2)} m/km): el terreno es prácticamente <b>plano</b> en este punto. Esto ocurre en una cima, en el fondo de una depresión o en un paso de montaña (puntos críticos).</p>`
        : `<p>Apunta hacia el <b>${rumboEnPalabras(anguloGradiente)}</b> (${f(anguloGradiente, 0)}°): esa es la dirección en la que el terreno <b>sube más rápido</b>. Su longitud es |∇h| = √(${f(gx)}² + ${f(gy)}²) = <b>${f(magnitudGradiente)} m/km</b>, es decir, una pendiente máxima de <b>${f(pendienteMaxima)} %</b> (${f(Math.atan(magnitudGradiente / 1000) * 180 / Math.PI)}°): terreno <b>${describirInclinacion(pendienteMaxima)}</b>.</p>
           <p>El agua hace lo contrario (−∇h): baja hacia el <b>${rumboEnPalabras(anguloAgua)}</b> (${f(anguloAgua, 0)}°).</p>`;

    let textoDireccional;
    if (casiPlano) {
        textoDireccional = `<p>Como el terreno es casi plano aquí, en cualquier rumbo la pendiente es casi 0 (D_u h = ${f(derivadaDireccional, 2)} m/km).</p>`;
    } else {
        const coseno = derivadaDireccional / magnitudGradiente;
        const relacion = coseno > 0.05
            ? `Vas <b>a favor</b> de la máxima subida: aprovechas el <b>${f(coseno * 100, 0)} %</b> de la pendiente máxima (cos φ = ${f(coseno, 2)}).`
            : coseno < -0.05
                ? `Vas <b>cuesta abajo</b>, en sentido contrario a la máxima subida (cos φ = ${f(coseno, 2)}).`
                : `Vas casi <b>de lado</b>, siguiendo una curva de nivel (cos φ ≈ 0).`;
        const vial = Math.abs(pendienteDireccional) <= 12
            ? `<span class="ok">Una vía en ese rumbo sería viable (pendiente ≤ 12 %).</span>`
            : `<span class="am">Una vía en ese rumbo NO sería viable (${f(Math.abs(pendienteDireccional))} % > 12 %). Gira el rumbo hacia ${f(anguloNivelA, 0)}° o ${f(anguloNivelB, 0)}°.</span>`;
        textoDireccional = `<p>Con el deslizador elegiste θ = <b>${thetaGrados}°</b> (hacia el <b>${rumboEnPalabras(thetaGrados)}</b>), es decir, la flecha unitaria u = ⟨cos θ, sen θ⟩ = ⟨${f(ux, 2)}, ${f(uy, 2)}⟩.</p>
            <div class="formula">D_u h = ∇h · u = (${f(gx)})(${f(ux, 2)}) + (${f(gy)})(${f(uy, 2)}) = ${f(derivadaDireccional)} m/km</div>
            <p>Equivale a <b>${f(pendienteDireccional)} %</b>: si caminas hacia el ${rumboEnPalabras(thetaGrados)}, el terreno <b>${verboCambio(derivadaDireccional)}</b> con una pendiente <b>${describirInclinacion(pendienteDireccional)}</b>. ${relacion}</p>
            <p>Para caminar <b>sin subir ni bajar</b> (curva de nivel) ve hacia el ${rumboEnPalabras(anguloNivelA)} (${f(anguloNivelA, 0)}°) o hacia el ${rumboEnPalabras(anguloNivelB)} (${f(anguloNivelB, 0)}°): allí D_u h = 0.</p>
            <p>${vial}</p>`;
    }

    obtenerElemento('p1').className = 'explica';
    obtenerElemento('p1').innerHTML = `
        <div class="bloque"><h3>1 · Dónde estamos</h3>
            <p>Punto <b>${nombre}</b>: x = ${f(x, 2)} km (este), y = ${f(y, 2)} km (norte). La altura del terreno aquí es <b>h = ${f(terreno.h)} m</b>.</p></div>
        <div class="bloque"><h3>2 · Derivadas parciales: cuánto cambia la altura en cada eje</h3>
            <p><b>∂h/∂x = ${f(gx)} m/km</b> → si avanzas 1 km hacia el <b>este</b>, el terreno <b>${verboCambio(gx)} ${f(Math.abs(gx))} m</b>.</p>
            <p><b>∂h/∂y = ${f(gy)} m/km</b> → si avanzas 1 km hacia el <b>norte</b>, el terreno <b>${verboCambio(gy)} ${f(Math.abs(gy))} m</b>.</p>
            <p class="nota">Son tasas de cambio (metros de altura por km recorrido). Cada una mide un solo eje: el otro se deja quieto.</p></div>
        <div class="bloque"><h3>3 · Gradiente ∇h: la flecha de máxima subida</h3>
            <div class="formula">∇h = ⟨∂h/∂x, ∂h/∂y⟩ = ⟨${f(gx)}, ${f(gy)}⟩</div>
            ${textoGradiente}</div>
        <div class="bloque"><h3>4 · Derivada direccional: la pendiente en el rumbo que tú eliges</h3>
            ${textoDireccional}</div>`;

    // ======================================================================
    // PANEL 1b: verificación
    // ======================================================================
    const filas = [
        ['∂h/∂x', gx, dxF, 1e-4],
        ['∂h/∂y', gy, dyF, 1e-4],
        ['h_xx (curvatura en x)', terreno.xx, dxxF, 1e-4],
        ['D_u h (direccional)', derivadaDireccional, duF, 1e-4]
    ];
    const tablaVerificacion = filas.map(([nombreMag, exacto, numerico, tolerancia]) =>
        `<tr><td>${nombreMag}</td><td>${f(exacto, 4)}</td><td>${f(numerico, 4)}</td><td>${formatearCientifico(Math.abs(exacto - numerico))}</td><td>${marcaOk(Math.abs(exacto - numerico) <= tolerancia * Math.max(1, Math.abs(exacto)))}</td></tr>`).join('');
    const ladoIzq = magnitudGradiente * magnitudGradiente;
    const ladoDer = derivadaDireccional ** 2 + derivadaPerpendicular ** 2;

    obtenerElemento('p2').className = 'explica';
    obtenerElemento('p2').innerHTML = `
        <div class="bloque"><h3>¿Cómo sabemos que el cálculo es correcto?</h3>
            <p>Cada derivada se calcula <b>de dos formas</b>: con la <b>fórmula exacta</b> (derivada analítica) y con una <b>prueba numérica</b>: se mide la altura un poquito antes y un poquito después del punto y se ve cuánto cambió (diferencias finitas). Si ambos resultados coinciden, la derivada está bien.</p>
            <table><tr><th>Magnitud</th><th>Fórmula exacta</th><th>Prueba numérica</th><th>Diferencia</th><th>¿Coincide?</th></tr>${tablaVerificacion}</table>
            <p class="nota">Identidad de Pitágoras: la pendiente máxima se reparte entre el rumbo elegido (u) y su perpendicular (v). |∇h|² = ${f(ladoIzq, 2)} y (D_u h)² + (D_v h)² = ${f(ladoDer, 2)} → ${marcaOk(Math.abs(ladoIzq - ladoDer) <= 1e-9 * Math.max(1, ladoIzq))}</p></div>`;

    // ======================================================================
    // PANEL 2: escorrentía
    // ======================================================================
    const flujoPunto = calcularFlujoAgua(x, y);
    const destinoFlujo = flujoPunto[flujoPunto.length - 1];
    const terrenoDestino = calcularTerreno(destinoFlujo.x, destinoFlujo.y);
    rutaPuntoP = flujoPunto.map(p => convertir3D(p.x, p.y, .07));
    const longitudFlujo = (flujoPunto.length - 1) * .03;
    const textoDestino = determinarDestinoFlujo(destinoFlujo);
    const saleDelMapa = textoDestino.startsWith('sale');
    const listaCuencas = depresionesMinimas.map((c, k) => `<li><b>D${k + 1}</b> (${f(c.x, 1)}, ${f(c.y, 1)}) km, a ${Math.round(c.h)} m → recibe el <b>${f(porcentajesCuencas[k], 0)} %</b> de la lluvia</li>`).join('');

    obtenerElemento('p3').className = 'explica';
    obtenerElemento('p3').innerHTML = `
        <div class="bloque"><h3>Una gota que cae en ${nombre}</h3>
            <p>La gota sigue la dirección −∇h (cuesta abajo, lo más empinado posible): sale hacia el <b>${casiPlano ? 'lugar más bajo cercano' : rumboEnPalabras(anguloAgua)}</b>, recorre <b>${f(longitudFlujo, 2)} km</b> y baja <b>${Math.round(terreno.h - terrenoDestino.h)} m</b>.</p>
            <p>Destino: <b>${textoDestino}</b>. ${saleDelMapa ? 'Se va hacia el borde del mapa sin quedar atrapada.' : 'Una depresión es un mínimo local: el agua queda atrapada y se acumula allí.'}</p></div>
        <div class="bloque"><h3>¿Hacia dónde se va la lluvia de todo el mapa?</h3>
            <p>Se sueltan 196 gotas repartidas en una rejilla de 14 × 14 y se sigue cada una hasta su destino:</p>
            <ul>${listaCuencas}<li>Sale del mapa → <b>${f(porcentajesCuencas[depresionesMinimas.length], 0)} %</b></li></ul>
            <p class="nota">Solo se considera la forma del terreno: no hay infiltración, caudal ni tipo de suelo.</p></div>`;

    // ======================================================================
    // PANEL 3: comparador de ubicaciones
    // ======================================================================
    const clavesABC = ['A', 'B', 'C'];
    const resultadosABC = clavesABC.map(k => evaluarPuntoAnalisis(POSICIONES_PUNTOS[k]));
    const mejorIndiceABC = resultadosABC.reduce((b, v, i) => v.i > resultadosABC[b].i ? i : b, 0);
    const destinosABC = clavesABC.map(k => { const p = calcularFlujoAgua(POSICIONES_PUNTOS[k].x, POSICIONES_PUNTOS[k].y); return determinarDestinoFlujo(p[p.length - 1]); });
    const mejor = resultadosABC[mejorIndiceABC];
    const bajoCota = mejor.t.h < alturaCorteCuenca;

    obtenerElemento('cmp').innerHTML = `<table><tr><th></th>${clavesABC.map(k => `<th style="color:${COLORES_PUNTOS[k]}">${k}</th>`).join('')}</tr><tr><td>Altura</td>${resultadosABC.map(v => `<td>${Math.round(v.t.h)} m</td>`).join('')}</tr><tr><td>Pendiente</td>${resultadosABC.map(v => `<td class="${v.s > 30 ? 'rd' : v.s > 15 ? 'am' : 'ok'}">${f(v.s)} %</td>`).join('')}</tr><tr><td>Escorrentía</td>${destinosABC.map(v => `<td style="font-size:11px">${v.replace('sale del dominio / sin depresión cercana', 'sale')}</td>`).join('')}</tr><tr><td>Índice (0–100)</td>${resultadosABC.map((v, i) => `<td><b>${f(v.i, 0)}${i == mejorIndiceABC ? ' ★' : ''}</b></td>`).join('')}</tr></table>
        <p class="n"><b>Lectura:</b> el sitio <b>${clavesABC[mejorIndiceABC]}</b> tiene el mayor índice (${f(mejor.i, 0)}) porque su pendiente es de ${f(mejor.s)} % (terreno ${describirInclinacion(mejor.s)}) y ${bajoCota ? `queda <b>por debajo</b> de la cota de acumulación (≈ ${Math.round(alturaCorteCuenca)} m), lo que reduce su índice` : `queda por encima de la cota de acumulación (≈ ${Math.round(alturaCorteCuenca)} m), sin penalización`}. Un sitio plano y alto es más favorable que uno inclinado o bajo.</p>`;

    // ======================================================================
    // PANEL 4: rutas
    // ======================================================================
    const analisisRuta1 = analizarMetricasRuta([POSICIONES_PUNTOS.A, POSICIONES_PUNTOS.B]);
    const analisisRuta2 = analizarMetricasRuta([POSICIONES_PUNTOS.A, POSICIONES_PUNTOS.C, POSICIONES_PUNTOS.B]);
    rutaA_B = analisisRuta1.pts; rutaA_C_B = analisisRuta2.pts;
    const veredicto = q => q.mx <= 12 ? '<span class="ok">Cumple ≤12 %</span>' : `<span class="am">Excede en ${f(q.bad, 0)} % del trazado</span>`;
    const fila = (nombreRuta, q) => `<tr><td>${nombreRuta}</td><td>${f(q.L, 2)} km</td><td>${f(q.mx)} %</td><td>${f(q.mean)} %</td><td>${Math.round(q.cl)} m</td><td>${veredicto(q)}</td></tr>`;
    const cumple1 = analisisRuta1.mx <= 12, cumple2 = analisisRuta2.mx <= 12;
    const conclusionLimite = cumple1 && cumple2 ? 'Ambas rutas cumplen el límite de 12 %.' : cumple1 ? 'Solo la ruta directa cumple el límite de 12 %.' : cumple2 ? 'Solo la ruta con desvío cumple el límite de 12 %.' : 'Ninguna de las dos rutas cumple el límite de 12 %.';
    const rutaMasSuave = analisisRuta1.mx <= analisisRuta2.mx ? 'A→B directa' : 'A→C→B';

    obtenerElemento('rt').innerHTML = `<table><tr><th>Ruta</th><th>Long. 3D</th><th>Pend. máx</th><th>Media</th><th>Subida</th><th>Veredicto</th></tr>${fila('A→B directa', analisisRuta1)}${fila('A→C→B', analisisRuta2)}</table>
        <p class="n"><b>Cómo se calcula:</b> en 120 puntos de cada tramo se mide la derivada direccional ∇h·T, donde T es la dirección en que avanzas por el camino. Es la pendiente que sentirías al caminar la ruta en ese punto.</p>
        <p class="n"><b>Lectura:</b> la ruta directa mide ${f(analisisRuta1.L, 2)} km y su tramo más empinado llega a ${f(analisisRuta1.mx)} %; la ruta con desvío mide ${f(analisisRuta2.L, 2)} km y llega a ${f(analisisRuta2.mx)} %. ${conclusionLimite} La de pendiente máxima más baja es <b>${rutaMasSuave}</b>, pero conviene mirar también la longitud y la subida acumulada.</p>`;

    // ======================================================================
    // PANEL 5: puntos críticos
    // ======================================================================
    const significado = { P: 'Cima: el terreno baja hacia todos lados', M: 'Depresión: el terreno sube hacia todos lados; el agua se acumula', S: 'Silla: sube en un sentido y baja en otro (paso de montaña)' };
    const nombreTipo = { P: 'Cima', M: 'Depresión', S: 'Silla' };
    const filasCriticos = puntosCriticos.map(c => `<tr><td>${nombreTipo[c.k]}</td><td>(${f(c.x, 2)}, ${f(c.y, 2)})</td><td>${Math.round(c.h)} m</td><td>${Math.round(c.D)}</td><td style="text-align:left">${significado[c.k]}</td></tr>`).join('');

    obtenerElemento('p4').className = 'explica';
    obtenerElemento('p4').innerHTML = `
        <div class="bloque"><h3>¿Qué es un punto crítico?</h3>
            <p>Es un lugar donde ∇h = 0: el terreno no sube ni baja en ninguna dirección, como la punta de una cima o el fondo de un hoyo. Para saber de qué tipo es se usa la segunda derivada con el número <b>D = h_xx · h_yy − (h_xy)²</b>:</p>
            <ul><li><b>D &gt; 0 y h_xx &lt; 0</b> → cima</li><li><b>D &gt; 0 y h_xx &gt; 0</b> → depresión</li><li><b>D &lt; 0</b> → silla</li></ul>
            <table><tr><th>Tipo</th><th>Posición (km)</th><th>Altura</th><th>D</th><th>Qué significa</th></tr>${filasCriticos}</table>
            <p class="nota">Cota de acumulación de referencia: ${Math.round(alturaCorteCuenca)} m (depresión más baja + 80 m).</p></div>`;

    solicitarRenderizado();
}

// ==========================================
// 8. CONFIGURACIÓN DE EVENTOS EN INTERFAZ
// ==========================================

document.querySelectorAll('#slots button').forEach(boton => {
    boton.onclick = () => {
        puntoActivo = boton.dataset.k;
        document.querySelectorAll('#slots button').forEach(x => x.classList.toggle('on', x == boton));
    };
});

['mh', 'ms'].forEach(id => {
    obtenerElemento(id).onclick = () => {
        modoVisualizacion = obtenerElemento(id).dataset.m;
        obtenerElemento('mh').classList.toggle('on', modoVisualizacion == 'h');
        obtenerElemento('ms').classList.toggle('on', modoVisualizacion == 's');
        pintarTerreno();
        solicitarRenderizado();
    };
});

obtenerElemento('th').oninput = actualizarPanelesInterfaz;
obtenerElemento('kc').onchange = solicitarRenderizado;
obtenerElemento('kl').onchange = solicitarRenderizado;

obtenerElemento('best').onclick = () => {
    let mejorPuntuacion = -1, mejorPunto = null;
    const centroPunto = POSICIONES_PUNTOS[puntoActivo];
    for (let i = 0; i < 100; i++) {
        for (let j = 0; j < 100; j++) {
            const p = { x: i / 10 + .05, y: j / 10 + .05 };
            if (Math.hypot(p.x - centroPunto.x, p.y - centroPunto.y) > 2) continue;
            const valorEvaluado = evaluarPuntoAnalisis(p).i;
            if (valorEvaluado > mejorPuntuacion) { mejorPuntuacion = valorEvaluado; mejorPunto = p; }
        }
    }
    POSICIONES_PUNTOS[puntoActivo] = mejorPunto;
    actualizarPanelesInterfaz();
};

addEventListener('resize', () => {
    const contenedorVisual = obtenerElemento('v'), densidadPixeles = devicePixelRatio || 1;
    anchoCanvas = contenedorVisual.clientWidth;
    altoCanvas = contenedorVisual.clientHeight;
    canvas.width = anchoCanvas * densidadPixeles;
    canvas.height = altoCanvas * densidadPixeles;
    contextoGrafico.setTransform(densidadPixeles, 0, 0, densidadPixeles, 0, 0);
    solicitarRenderizado();
});

// Inicialización general
construirTerreno();
const contenedorVisual = obtenerElemento('v'), densidadPixeles = devicePixelRatio || 1;
anchoCanvas = contenedorVisual.clientWidth;
altoCanvas = contenedorVisual.clientHeight;
canvas.width = anchoCanvas * densidadPixeles;
canvas.height = altoCanvas * densidadPixeles;
contextoGrafico.setTransform(densidadPixeles, 0, 0, densidadPixeles, 0, 0);
actualizarPanelesInterfaz();

