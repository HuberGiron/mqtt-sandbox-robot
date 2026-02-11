// Función para seleccionar la imagen adecuada según el ancho de la pantalla
function chooseRobotImage() {
  // Si el ancho de pantalla es menor a 600, se usa la versión pequeña
  return window.innerWidth < 600 ? 'robot_mobile_small.png' : 'robot.png';
}

let robotImg = new Image();
robotImg.src = chooseRobotImage();

// Actualiza la imagen del robot si cambia el ancho de la pantalla
function updateRobotImage() {
  const newSrc = chooseRobotImage();
  if (robotImg.src.indexOf(newSrc) === -1) {
    robotImg = new Image();
    robotImg.src = newSrc;
    robotImg.onload = updateCanvasSize;
  }
}

const canvas = document.getElementById('robotCanvas');
const ctx = canvas.getContext('2d');

// Área de simulación: eje X de -300 a 300 y eje Y de -200 a 200
const SIM_X_MIN = -300, SIM_X_MAX = 300;
const SIM_Y_MIN = -200, SIM_Y_MAX = 200;
const SIM_WIDTH = SIM_X_MAX - SIM_X_MIN;   // 600
const SIM_HEIGHT = SIM_Y_MAX - SIM_Y_MIN;  // 400

// Dimensiones originales del robot (en mm)
const originalRobotWidth = 150;

// Estado de simulación
let simState = 'idle'; // 'idle' | 'running' | 'paused'
let animationId = null;
let cycleCount = 0;

// Para avanzar la simulación en "tiempo real" usando dt (s)
let lastTs = null;
let accumulator = 0;
const MAX_STEPS_PER_FRAME = 5;

const robot = new Robot();

// Configuración actual del robot (en mm)
const config = {
  robotWidth: originalRobotWidth,
  robotHeight: 0
};

// Variables para el tamaño visible
let visibleWidth = 0, visibleHeight = 0;
// Forzamos _dpr a 1 para que el tamaño interno sea igual al tamaño visual
let _dpr = 1;

// Arreglos para datos de las gráficas
let timeData = [];
let errorXData = [];
let errorYData = [];
let posXData = [];
let posYData = [];
let VData = [];
let WData = [];
let thetaDegData = [];
let goalXData = [];
let goalYData = [];


// --- Rendimiento / visualización
// Mantener una ventana acotada de puntos para las gráficas (evita que Chart.js se vuelva lento)
const MAX_PLOT_POINTS = 1200;     // puntos visibles en charts
const PLOT_TRIM_CHUNK = 300;      // recorte por bloques para evitar shift() por frame
const CHART_UPDATE_MS = 120;      // ~8 Hz (suficiente para ver en vivo sin cargar CPU)

let timePlot = [];
let errorXPlot = [];
let errorYPlot = [];
let posXPlot = [];
let posYPlot = [];
let VPlot = [];
let WPlot = [];
let goalXPlot = [];
let goalYPlot = [];

let chartsDirty = false;
let lastChartUpdateTs = 0;

const INFO_UPDATE_MS = 120;       // throttling de panel de info del robot
let lastInfoUpdateTs = 0;

// Capas offscreen: (1) fondo+grid fijo, (2) trayectoria incremental
const staticLayer = document.createElement('canvas');
const staticCtx = staticLayer.getContext('2d');

const trailLayer = document.createElement('canvas');
const trailCtx = trailLayer.getContext('2d');

let renderCache = { scaleFactor: 1, cx: 0, cy: 0, w: 0, h: 0 };

function resetTransformSafe(c) {
  if (typeof c.resetTransform === 'function') c.resetTransform();
  else c.setTransform(1, 0, 0, 1, 0, 0);
}

function updateRenderCache() {
  const actualWidth = canvas.width;
  const actualHeight = canvas.height;
  renderCache.w = actualWidth;
  renderCache.h = actualHeight;
  renderCache.scaleFactor = actualWidth / SIM_WIDTH;
  renderCache.cx = actualWidth / 2;
  renderCache.cy = actualHeight / 2;
}

function simToPx(x, y) {
  // Mapeo equivalente a: setTransform(scaleFactor,0,0,-scaleFactor,cx,cy)
  return {
    px: renderCache.cx + x * renderCache.scaleFactor,
    py: renderCache.cy - y * renderCache.scaleFactor
  };
}

function resizeOffscreenLayers() {
  if (staticLayer.width !== canvas.width || staticLayer.height !== canvas.height) {
    staticLayer.width = canvas.width;
    staticLayer.height = canvas.height;
  }
  if (trailLayer.width !== canvas.width || trailLayer.height !== canvas.height) {
    trailLayer.width = canvas.width;
    trailLayer.height = canvas.height;
  }
}

function renderStaticLayer() {
  // Fondo y rejilla: se redibuja SOLO cuando cambia el tamaño del canvas
  resetTransformSafe(staticCtx);
  staticCtx.clearRect(0, 0, staticLayer.width, staticLayer.height);

  staticCtx.setTransform(renderCache.scaleFactor, 0, 0, -renderCache.scaleFactor, renderCache.cx, renderCache.cy);

  // Fondo
  staticCtx.save();
  const grd = staticCtx.createLinearGradient(SIM_X_MIN, SIM_Y_MIN, SIM_X_MAX, SIM_Y_MAX);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(1, '#f8f8f8');
  staticCtx.fillStyle = grd;
  staticCtx.fillRect(SIM_X_MIN, SIM_Y_MIN, SIM_WIDTH, SIM_HEIGHT);
  staticCtx.restore();

  // Grid (tomado de drawGrid, pero en la capa offscreen)
  staticCtx.save();
  staticCtx.strokeStyle = "#e0e0e0";
  staticCtx.lineWidth = 1 / renderCache.scaleFactor;
  staticCtx.font = '14px Arial';
  staticCtx.fillStyle = '#000000';

  const margin = 20;
  const divisions = 10;
  const stepX = (SIM_X_MAX - SIM_X_MIN) / divisions;
  const stepY = (SIM_Y_MAX - SIM_Y_MIN) / divisions;

  for (let i = 0; i <= divisions; i++) {
    const x = SIM_X_MIN + i * stepX;
    staticCtx.beginPath();
    staticCtx.moveTo(x, SIM_Y_MIN);
    staticCtx.lineTo(x, SIM_Y_MAX);
    staticCtx.stroke();

    staticCtx.save();
    staticCtx.scale(1, -1);
    staticCtx.fillText(x.toFixed(0), x, -(SIM_Y_MIN) + margin);
    staticCtx.restore();
  }

  for (let i = 0; i <= divisions; i++) {
    const y = SIM_Y_MIN + i * stepY;
    staticCtx.beginPath();
    staticCtx.moveTo(SIM_X_MIN, y);
    staticCtx.lineTo(SIM_X_MAX, y);
    staticCtx.stroke();

    staticCtx.save();
    staticCtx.scale(1, -1);
    staticCtx.fillText(y.toFixed(0), SIM_X_MIN + margin, -y);
    staticCtx.restore();
  }

  // Ejes
  staticCtx.strokeStyle = "#000000";
  staticCtx.lineWidth = 2 / renderCache.scaleFactor;

  staticCtx.beginPath();
  staticCtx.moveTo(SIM_X_MIN, 0);
  staticCtx.lineTo(SIM_X_MAX, 0);
  staticCtx.stroke();

  staticCtx.beginPath();
  staticCtx.moveTo(0, SIM_Y_MIN);
  staticCtx.lineTo(0, SIM_Y_MAX);
  staticCtx.stroke();

  staticCtx.restore();
}

function clearTrailLayer() {
  resetTransformSafe(trailCtx);
  trailCtx.clearRect(0, 0, trailLayer.width, trailLayer.height);
}

function rebuildTrailFromTrajectory() {
  // Se usa SOLO en resize o reinicios; la trayectoria está acotada en robot.js
  clearTrailLayer();
  const traj = robot.getTrajectory?.() || [];
  if (!traj || traj.length < 2) return;

  trailCtx.save();
  trailCtx.lineWidth = 3;
  trailCtx.strokeStyle = '#ff0000';
  trailCtx.lineJoin = 'round';
  trailCtx.lineCap = 'round';

  trailCtx.beginPath();
  const p0 = simToPx(traj[0].x, traj[0].y);
  trailCtx.moveTo(p0.px, p0.py);

  for (let i = 1; i < traj.length; i++) {
    const p = simToPx(traj[i].x, traj[i].y);
    trailCtx.lineTo(p.px, p.py);
  }
  trailCtx.stroke();
  trailCtx.restore();
}

function addTrailSegment(x0, y0, x1, y1) {
  // Dibuja incrementalmente SOLO el último segmento (O(1) por paso)
  const p0 = simToPx(x0, y0);
  const p1 = simToPx(x1, y1);

  trailCtx.save();
  trailCtx.lineWidth = 3;
  trailCtx.strokeStyle = '#ff0000';
  trailCtx.lineJoin = 'round';
  trailCtx.lineCap = 'round';

  trailCtx.beginPath();
  trailCtx.moveTo(p0.px, p0.py);
  trailCtx.lineTo(p1.px, p1.py);
  trailCtx.stroke();
  trailCtx.restore();
}

function trimPlotDataIfNeeded() {
  // Recorta por bloques para mantener rendimiento y evitar operaciones O(n) cada ciclo
  if (timePlot.length <= MAX_PLOT_POINTS + PLOT_TRIM_CHUNK) return;
  const removeN = timePlot.length - MAX_PLOT_POINTS;
  const n = Math.min(removeN, PLOT_TRIM_CHUNK);

  timePlot.splice(0, n);
  errorXPlot.splice(0, n);
  errorYPlot.splice(0, n);
  posXPlot.splice(0, n);
  posYPlot.splice(0, n);
  VPlot.splice(0, n);
  WPlot.splice(0, n);
  goalXPlot.splice(0, n);
  goalYPlot.splice(0, n);
}

function maybeUpdateCharts(ts, force = false) {
  if (!chartsDirty && !force) return;
  if (!force && (ts - lastChartUpdateTs) < CHART_UPDATE_MS) return;

  // Alimenta explícitamente las gráficas con los arrays *acotados* (Plot arrays)
  // para mantener rendimiento y evitar desincronizaciones si hay recortes.
  updateCharts(
    'none'
  );
  
  chartsDirty = false;
  lastChartUpdateTs = ts;
}

function maybeUpdateRobotInfo(ts, force = false) {
  if (!force && (ts - lastInfoUpdateTs) < INFO_UPDATE_MS) return;
  updateRobotInfo();
  lastInfoUpdateTs = ts;
}


// Objetivo deseado (manual o MQTT)
const desired = {
  x: 100,
  y: 100,
  source: 'manual', // 'manual' | 'mqtt'
  lastUpdateMs: Date.now()
};

// MQTT (cliente en navegador via mqtt.js)
let mqttClient = null;
let mqttIsConnected = false;
let mqttSubscribedTopic = '';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Función para ajustar el tamaño del canvas según el contenedor
function updateCanvasSize() {
  const container = document.querySelector('.canvas-container');
  if (!container) return;

  _dpr = 1;
  visibleWidth = container.clientWidth;
  visibleHeight = visibleWidth * (0.68);

  canvas.style.width = visibleWidth + 'px';
  canvas.style.height = visibleHeight + 'px';

  canvas.width = visibleWidth;
  canvas.height = visibleHeight;

  resetTransformSafe(ctx);
  ctx.scale(_dpr, _dpr);
  ctx.imageSmoothingEnabled = true;

  const actualWidth = canvas.width;
  const referenceValue = visibleWidth < 600 ? 450 : 900;
  config.robotWidth = originalRobotWidth * (actualWidth / referenceValue);
  if (robotImg.complete) {
    config.robotHeight = robotImg.height * config.robotWidth / robotImg.width;
  }

  // Preparar caches/capas offscreen
  updateRenderCache();
  resizeOffscreenLayers();
  renderStaticLayer();
  rebuildTrailFromTrajectory();

  drawAllElements();
  maybeUpdateRobotInfo(performance.now(), true);
}


let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    updateRobotImage();
    updateCanvasSize();
  }, 100);
});

// Elementos UI
const startXInput = document.getElementById('startX');
const startYInput = document.getElementById('startY');
const angleInput = document.getElementById('angle');
const endXInput = document.getElementById('endX');
const endYInput = document.getElementById('endY');
const kInput = document.getElementById('k');
const lInput = document.getElementById('l');
const dtInput = document.getElementById('dt');

const animateBtn = document.getElementById('animateBtn');
const restartBtn = document.getElementById('restartBtn');
const saveSessionBtn = document.getElementById('saveSessionBtn');

const mqttPanel = document.getElementById('mqttPanel');
const mqttUrlInput = document.getElementById('mqttUrl');
const mqttTopicInput = document.getElementById('mqttTopic');
const mqttConnectBtn = document.getElementById('mqttConnectBtn');
const mqttStatusEl = document.getElementById('mqttStatus');

// --- Eventos UI
animateBtn.addEventListener('click', toggleSimulation);
restartBtn.addEventListener('click', resetSimulation);
saveSessionBtn.addEventListener('click', downloadSessionCSV);

// Inputs "de arranque" (solo en idle)
[startXInput, startYInput, angleInput, kInput, lInput, dtInput].forEach(inp => {
  inp.addEventListener('input', updatePreview);
});

// Objetivo manual: debe poder cambiar incluso en running/paused
[endXInput, endYInput].forEach(inp => {
  inp.addEventListener('input', () => {
    if (desired.source === 'manual') {
      updateDesiredFromInputs();
    }
    drawAllElements();
  });
});

// Selector Manual/MQTT
document.querySelectorAll('input[name="targetSource"]').forEach(radio => {
  radio.addEventListener('change', () => {
    setTargetSource(document.querySelector('input[name="targetSource"]:checked').value);
  });
});

// MQTT connect/disconnect
mqttConnectBtn.addEventListener('click', () => {
  if (mqttIsConnected) {
    mqttDisconnect();
  } else {
    mqttConnect();
  }
});

// Si cambia el tópico mientras estás conectado, re-suscribir
mqttTopicInput.addEventListener('input', () => {
  if (mqttIsConnected) {
    mqttResubscribe();
  }
});

// Inicialización cuando carga la imagen
robotImg.onload = () => {
  updateCanvasSize();
  updateDesiredFromInputs(); // set initial desired from UI
  updatePreview(); // aplica condiciones iniciales (solo si idle)
  initCharts(timePlot, errorXPlot, errorYPlot, posXPlot, posYPlot, VPlot, WPlot, goalXPlot, goalYPlot);
};

// --- Lógica de objetivo (manual/MQTT)
function setTargetSource(source) {
  desired.source = (source === 'mqtt') ? 'mqtt' : 'manual';

  if (desired.source === 'mqtt') {
    // El objetivo viene de mensajes; el usuario no teclea
    endXInput.disabled = true;
    endYInput.disabled = true;
    mqttPanel.style.display = 'block';
  } else {
    endXInput.disabled = false;
    endYInput.disabled = false;
    mqttPanel.style.display = 'none';
    updateDesiredFromInputs();
  }

  drawAllElements();
}

function updateDesiredFromInputs() {
  const x = parseFloat(endXInput.value);
  const y = parseFloat(endYInput.value);
  if (Number.isFinite(x)) desired.x = clamp(x, SIM_X_MIN, SIM_X_MAX);
  if (Number.isFinite(y)) desired.y = clamp(y, SIM_Y_MIN, SIM_Y_MAX);

  // Refleja clamp si aplica
  endXInput.value = desired.x;
  endYInput.value = desired.y;

  desired.lastUpdateMs = Date.now();
}

function setDesired(x, y, origin = 'mqtt') {
  // Solo aceptamos cambios por MQTT cuando el modo es MQTT
  if (origin === 'mqtt' && desired.source !== 'mqtt') return;

  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  desired.x = clamp(x, SIM_X_MIN, SIM_X_MAX);
  desired.y = clamp(y, SIM_Y_MIN, SIM_Y_MAX);

  // Reflejar en UI (aunque esté deshabilitado)
  endXInput.value = desired.x;
  endYInput.value = desired.y;

  desired.lastUpdateMs = Date.now();
}

// --- Previsualización (solo en idle)
function updatePreview() {
  if (simState !== 'idle') return;

  const startX = parseFloat(startXInput.value);
  const startY = parseFloat(startYInput.value);
  const angle = parseFloat(angleInput.value);

  robot.setInitialConditions(startX, startY, angle);

  robot.k = parseFloat(kInput.value);
  robot.l = parseFloat(lInput.value);
  robot.dt = parseFloat(dtInput.value);

  if (desired.source === 'manual') {
    updateDesiredFromInputs();
  }

  // Reinicia trayectoria visual (offscreen) para que no se re-dibuje todo cada frame
  updateRenderCache();
  resizeOffscreenLayers();
  renderStaticLayer();
  rebuildTrailFromTrajectory();

  drawAllElements();
  maybeUpdateRobotInfo(performance.now(), true);
}


// --- Dibujo
function drawAllElements() {
  // Composición en 3 capas: fondo fijo + trayectoria + elementos dinámicos
  resetTransformSafe(ctx);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (staticLayer.width) ctx.drawImage(staticLayer, 0, 0);
  if (trailLayer.width) ctx.drawImage(trailLayer, 0, 0);

  ctx.setTransform(renderCache.scaleFactor, 0, 0, -renderCache.scaleFactor, renderCache.cx, renderCache.cy);
  drawRobot();
  drawPointsCircles();

  resetTransformSafe(ctx);
  drawPointsLabels();
}


function drawGrid() {
  ctx.save();
  ctx.strokeStyle = "#e0e0e0";
  const actualWidth = canvas.width;
  const scaleFactor = actualWidth / SIM_WIDTH;
  ctx.lineWidth = 1 / scaleFactor;
  ctx.font = '14px Arial';
  ctx.fillStyle = '#000000';

  const margin = 20;
  const divisions = (window.innerWidth >= 768) ? 4 : 3;
  const stepX = SIM_WIDTH / (2 * divisions);
  const stepY = SIM_HEIGHT / (2 * divisions);

  for (let x = SIM_X_MIN; x <= SIM_X_MAX; x += stepX) {
    ctx.beginPath();
    ctx.moveTo(x, SIM_Y_MIN);
    ctx.lineTo(x, SIM_Y_MAX);
    ctx.stroke();
    if (x > SIM_X_MIN + margin && x < SIM_X_MAX - margin) {
      ctx.save();
      ctx.scale(1, -1);
      ctx.fillText(`${Math.round(x)} mm`, x - 15, -SIM_Y_MIN - 10);
      ctx.restore();
    }
  }

  for (let y = SIM_Y_MIN; y <= SIM_Y_MAX; y += stepY) {
    ctx.beginPath();
    ctx.moveTo(SIM_X_MIN, y);
    ctx.lineTo(SIM_X_MAX, y);
    ctx.stroke();
    if (y > SIM_Y_MIN + margin && y < SIM_Y_MAX - margin) {
      ctx.save();
      ctx.scale(1, -1);
      ctx.fillText(`${Math.round(y)} mm`, SIM_X_MIN + 10, -y + 15);
      ctx.restore();
    }
  }

  ctx.beginPath();
  ctx.moveTo(0, SIM_Y_MIN);
  ctx.lineTo(0, SIM_Y_MAX);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(SIM_X_MIN, 0);
  ctx.lineTo(SIM_X_MAX, 0);
  ctx.stroke();
  ctx.restore();
}

function drawRobot() {
  const pos = robot.getCurrentPosition();
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
  ctx.shadowBlur = 10;
  ctx.translate(pos.x, pos.y);
  ctx.rotate(robot.theta);
  ctx.drawImage(robotImg, robot.l - config.robotWidth, -config.robotHeight / 2, config.robotWidth, config.robotHeight);
  ctx.restore();
}

function drawTrajectory() {
  const trajectory = robot.getTrajectory();
  if (trajectory.length < 2) return;
  ctx.save();
  const actualWidth = canvas.width;
  const scaleFactor = actualWidth / SIM_WIDTH;
  ctx.lineWidth = 3 / scaleFactor;
  ctx.strokeStyle = '#ff0000';

  ctx.beginPath();
  ctx.moveTo(trajectory[0].x, trajectory[0].y);
  for (const point of trajectory) {
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPointsCircles() {
  const startX = parseFloat(startXInput.value);
  const startY = parseFloat(startYInput.value);

  // Ojo: el "punto deseado" siempre se toma del UI (se actualiza desde MQTT cuando aplica)
  const endX = parseFloat(endXInput.value);
  const endY = parseFloat(endYInput.value);

  drawCircle(startX, startY, '#00FF00');
  drawCircle(endX, endY, '#0000FF');

  const extPoint = robot.getExtensionPoint();
  drawCircle(extPoint.x, extPoint.y, '#FF0000');
}

function drawCircle(x, y, color) {
  ctx.beginPath();
  const actualWidth = canvas.width;
  const scaleFactor = actualWidth / SIM_WIDTH;
  ctx.arc(x, y, 3 / scaleFactor, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawPointsLabels() {
  const actualWidth = canvas.width;
  const scaleFactor = actualWidth / SIM_WIDTH;
  const cx = actualWidth / 2;
  const cy = canvas.height / 2;

  const startX = parseFloat(startXInput.value);
  const startY = parseFloat(startYInput.value);
  const endX = parseFloat(endXInput.value);
  const endY = parseFloat(endYInput.value);

  const startCanvasX = cx + startX * scaleFactor;
  const startCanvasY = cy - startY * scaleFactor;
  const endCanvasX = cx + endX * scaleFactor;
  const endCanvasY = cy - endY * scaleFactor;

  ctx.save();
  ctx.resetTransform();
  ctx.font = 'bold 14px Arial';
  ctx.fillStyle = '#000000';
  ctx.fillText('(Xo, Yo)', startCanvasX + 10, startCanvasY - 10);
  ctx.fillText('(Xs, Ys)', endCanvasX + 10, endCanvasY - 10);
  ctx.restore();
}

function updateRobotInfo() {
  const pos = robot.getCurrentPosition();
  document.getElementById('robotInfo').textContent =
    `Posición: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) | Ángulo: ${(robot.theta * 180 / Math.PI).toFixed(1)}° | Objetivo(${desired.source.toUpperCase()}): (${desired.x.toFixed(0)}, ${desired.y.toFixed(0)})`;
}

// --- Simulación (start/pause/resume)
function toggleSimulation() {
  if (simState === 'running') {
    pauseSimulation();
  } else if (simState === 'paused') {
    resumeSimulation();
  } else {
    startSimulation();
  }
}

function setInputsEnabled(enabled) {
  startXInput.disabled = !enabled;
  startYInput.disabled = !enabled;
  angleInput.disabled = !enabled;
  kInput.disabled = !enabled;
  lInput.disabled = !enabled;
  dtInput.disabled = !enabled;
}

function startSimulation() {
  // Congelar parámetros iniciales
  updatePreview(); // aplica robot.setInitialConditions + k,l,dt (solo si idle)

  // Reset de datos de sesión (mantener referencias; NO reasignar arrays)
  cycleCount = 0;

  timeData.length = 0;
  errorXData.length = 0;
  errorYData.length = 0;
  posXData.length = 0;
  posYData.length = 0;
  VData.length = 0;
  WData.length = 0;
  thetaDegData.length = 0;
  goalXData.length = 0;
  goalYData.length = 0;

  timePlot.length = 0;
  errorXPlot.length = 0;
  errorYPlot.length = 0;
  posXPlot.length = 0;
  posYPlot.length = 0;
  VPlot.length = 0;
  WPlot.length = 0;
  goalXPlot.length = 0;
  goalYPlot.length = 0;

  chartsDirty = true;
  lastChartUpdateTs = 0;

  // Reset acumuladores de tiempo
  lastTs = null;
  accumulator = 0;

  // Limpia trayectoria visual
  updateRenderCache();
  resizeOffscreenLayers();
  renderStaticLayer();
  clearTrailLayer(); // la trayectoria se dibuja incrementalmente en doSimStep()

  // UI
  simState = 'running';
  animateBtn.innerHTML = `<span id="animateIcon">&#10074;&#10074;</span> Pausa`;
  setInputsEnabled(false);

  // Forzar charts vacíos en pantalla
  maybeUpdateCharts(performance.now(), true);

  animationId = requestAnimationFrame(animateFrame);
}


function pauseSimulation() {
  simState = 'paused';
  cancelAnimationFrame(animationId);
  animationId = null;
  lastTs = null;
  accumulator = 0;
  animateBtn.innerHTML = `<span id="animateIcon">&#9658;</span> Reanudar`;
}

function resumeSimulation() {
  simState = 'running';
  animateBtn.innerHTML = `<span id="animateIcon">&#10074;&#10074;</span> Pausa`;
  lastTs = null;
  accumulator = 0;
  animationId = requestAnimationFrame(animateFrame);
}

function resetSimulation() {
  // Para y limpia
  simState = 'idle';
  cancelAnimationFrame(animationId);
  animationId = null;

  cycleCount = 0;
  document.getElementById('cycleCounter').textContent = `Ciclos: ${cycleCount} - Tiempo: 0.00 s`;

  timeData.length = 0;
  errorXData.length = 0;
  errorYData.length = 0;
  posXData.length = 0;
  posYData.length = 0;
  VData.length = 0;
  WData.length = 0;
  thetaDegData.length = 0;
  goalXData.length = 0;
  goalYData.length = 0;

  timePlot.length = 0;
  errorXPlot.length = 0;
  errorYPlot.length = 0;
  posXPlot.length = 0;
  posYPlot.length = 0;
  VPlot.length = 0;
  WPlot.length = 0;
  goalXPlot.length = 0;
  goalYPlot.length = 0;

  chartsDirty = true;
  lastChartUpdateTs = 0;

  // UI
  animateBtn.innerHTML = `<span id="animateIcon">&#9658;</span> Iniciar`;
  setInputsEnabled(true);

  // Volver a condiciones actuales del formulario
  const startX = parseFloat(startXInput.value);
  const startY = parseFloat(startYInput.value);
  const angle = parseFloat(angleInput.value);
  robot.setInitialConditions(startX, startY, angle);

  if (desired.source === 'manual') updateDesiredFromInputs();

  // Re-render fondo + limpiar trayectoria
  updateRenderCache();
  resizeOffscreenLayers();
  renderStaticLayer();
  clearTrailLayer();

  drawAllElements();
  maybeUpdateCharts(performance.now(), true);
  maybeUpdateRobotInfo(performance.now(), true);
}


function animateFrame(ts) {
  if (simState !== 'running') return;

  if (lastTs === null) {
    lastTs = ts;
    animationId = requestAnimationFrame(animateFrame);
    return;
  }

  let dtWall = (ts - lastTs) / 1000;
  lastTs = ts;

  // Evitar saltos enormes si la pestaña se durmió
  if (dtWall > 0.25) dtWall = 0.25;

  accumulator += dtWall;

  let steps = 0;
  while (accumulator >= robot.dt && steps < MAX_STEPS_PER_FRAME) {
    doSimStep();
    accumulator -= robot.dt;
    steps++;
  }

  drawAllElements();
  maybeUpdateCharts(ts);
  maybeUpdateRobotInfo(ts);

  animationId = requestAnimationFrame(animateFrame);
}


function doSimStep() {
  cycleCount++;
  const t = cycleCount * robot.dt;
  document.getElementById('cycleCounter').textContent = `Ciclos: ${cycleCount} - Tiempo: ${t.toFixed(2)} s`;

  // Guardar pose previa para dibujar SOLO el último segmento de trayectoria
  const prevX = robot.x;
  const prevY = robot.y;

  const { ex, ey, V, W } = robot.calculateControl(desired.x, desired.y);

  // Log completo (para CSV/descargas)
  timeData.push(parseFloat(t.toFixed(2)));
  errorXData.push(ex);
  errorYData.push(ey);
  posXData.push(robot.x);
  posYData.push(robot.y);
  VData.push(V);
  WData.push(W);
  thetaDegData.push(robot.theta * 180 / Math.PI);
  goalXData.push(desired.x);
  goalYData.push(desired.y);

  // Ventana acotada (para Chart.js)
  timePlot.push(parseFloat(t.toFixed(2)));
  errorXPlot.push(ex);
  errorYPlot.push(ey);
  posXPlot.push(robot.x);
  posYPlot.push(robot.y);
  VPlot.push(V);
  WPlot.push(W);
  goalXPlot.push(desired.x);
  goalYPlot.push(desired.y);
  trimPlotDataIfNeeded();

  // Trayectoria incremental (O(1) por paso)
  addTrailSegment(prevX, prevY, robot.x, robot.y);

  chartsDirty = true;
}


// --- MQTT
function setMqttStatus(state, text) {
  mqttStatusEl.textContent = text;
  mqttStatusEl.classList.remove('offline', 'connecting', 'online');
  mqttStatusEl.classList.add(state);
}

function mqttConnect() {
  const url = (mqttUrlInput.value || '').trim();
  const topic = (mqttTopicInput.value || '').trim();
  if (!url || !topic) {
    setMqttStatus('offline', 'URL/tópico vacío');
    return;
  }

  // Si ya había cliente, cerrarlo antes
  mqttDisconnect();

  setMqttStatus('connecting', 'Conectando...');
  mqttConnectBtn.textContent = 'Conectar';

  try {
    mqttClient = mqtt.connect(url, {
      keepalive: 30,
      reconnectPeriod: 1000,
      connectTimeout: 8000,
      clean: true
    });
  } catch (e) {
    console.error(e);
    setMqttStatus('offline', 'Error al crear cliente');
    mqttClient = null;
    mqttIsConnected = false;
    return;
  }

  mqttClient.on('connect', () => {
    mqttIsConnected = true;
    setMqttStatus('online', 'Conectado');
    mqttConnectBtn.textContent = 'Desconectar';
    mqttResubscribe();
  });

  mqttClient.on('reconnect', () => {
    setMqttStatus('connecting', 'Reconectando...');
  });

  mqttClient.on('close', () => {
    mqttIsConnected = false;
    setMqttStatus('offline', 'Desconectado');
    mqttConnectBtn.textContent = 'Conectar';
  });

  mqttClient.on('error', (err) => {
    console.error(err);
    mqttIsConnected = false;
    setMqttStatus('offline', 'Error MQTT');
    mqttConnectBtn.textContent = 'Conectar';
  });

  mqttClient.on('message', (t, msg) => {
    if (t !== mqttSubscribedTopic) return;
    const payload = msg.toString();
    const parsed = parseGoalPayload(payload);
    if (!parsed) return;
    setDesired(parsed.x, parsed.y, 'mqtt');
  });
}

function mqttDisconnect() {
  if (mqttClient) {
    try {
      mqttClient.end(true);
    } catch (e) {
      console.error(e);
    }
  }
  mqttClient = null;
  mqttIsConnected = false;
  mqttSubscribedTopic = '';
  setMqttStatus('offline', 'Desconectado');
  mqttConnectBtn.textContent = 'Conectar';
}

function mqttResubscribe() {
  if (!mqttClient || !mqttIsConnected) return;

  const topic = (mqttTopicInput.value || '').trim();
  if (!topic) return;

  // Si cambió el topic, re-suscribir
  if (mqttSubscribedTopic && mqttSubscribedTopic !== topic) {
    try { mqttClient.unsubscribe(mqttSubscribedTopic); } catch (e) {}
  }

  mqttSubscribedTopic = topic;

  mqttClient.subscribe(topic, { qos: 0 }, (err) => {
    if (err) {
      console.error(err);
      setMqttStatus('offline', 'Error al suscribir');
    }
  });
}

// Acepta {"x":100,"y":-50} o "100,-50" o "100 -50"
function parseGoalPayload(payload) {
  if (!payload) return null;
  const s = String(payload).trim();
  if (!s) return null;

  // Intento JSON
  try {
    const obj = JSON.parse(s);
    if (obj && Number.isFinite(obj.x) && Number.isFinite(obj.y)) {
      return { x: Number(obj.x), y: Number(obj.y) };
    }
  } catch (_) {}

  // Intento CSV/espacios
  const parts = s.split(/[\s,;]+/).filter(Boolean);
  if (parts.length >= 2) {
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return null;
}

// --- Descargas
function downloadSessionCSV() {
  if (!timeData.length) {
    alert('No hay datos para guardar todavía. Inicia la simulación primero.');
    return;
  }

  let csv = 't_s,x_mm,y_mm,theta_deg,ex_mm,ey_mm,V_mm_s,W_rad_s,xs_mm,ys_mm\n';
  for (let i = 0; i < timeData.length; i++) {
    const row = [
      timeData[i],
      posXData[i],
      posYData[i],
      thetaDegData[i],
      errorXData[i],
      errorYData[i],
      VData[i],
      WData[i],
      goalXData[i],
      goalYData[i]
    ];
    csv += row.join(',') + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  link.href = url;
  link.download = `robot_session_${ts}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Función para descargar la imagen actual del canvas de la animación
function downloadCanvas() {
  const dataURL = canvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.href = dataURL;
  link.download = 'animacion_canvas.png';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Inicializa el modo en UI (por si el HTML cambia el "checked" por defecto)
setTargetSource(document.querySelector('input[name="targetSource"]:checked')?.value || 'manual');
