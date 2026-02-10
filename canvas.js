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
const SIM_HEIGHT = SIM_Y_MAX - SIM_Y_MIN;    // 400

// Dimensiones originales del robot (en mm)
const originalRobotWidth = 150; // Valor original para robotWidth

let isAnimating = false;
let animationId;
let cycleCount = 0;
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

// Función para ajustar el tamaño del canvas según el contenedor
function updateCanvasSize() {
  const container = document.querySelector('.canvas-container');
  if (container) {
    _dpr = 1;
    visibleWidth = container.clientWidth;
    visibleHeight = visibleWidth * (0.68);  // Ajustado a 0.68

    canvas.style.width = visibleWidth + 'px';
    canvas.style.height = visibleHeight + 'px';

    canvas.width = visibleWidth;
    canvas.height = visibleHeight;

    ctx.resetTransform();
    ctx.scale(_dpr, _dpr);
    ctx.imageSmoothingEnabled = true;

    const actualWidth = canvas.width;
    const referenceValue = visibleWidth < 600 ? 450 : 900;
    config.robotWidth = originalRobotWidth * (actualWidth / referenceValue);
    if (robotImg.complete) {
      config.robotHeight = robotImg.height * config.robotWidth / robotImg.width;
    }
    drawAllElements();
  }
}

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    updateRobotImage();
    updateCanvasSize();
  }, 100);
});

document.getElementById('animateBtn').addEventListener('click', toggleAnimation);
document.getElementById('restartBtn').addEventListener('click', resetAnimation);
document.querySelectorAll('input').forEach(input => {
  input.addEventListener('input', updatePreview);
});

robotImg.onload = () => {
  updateCanvasSize();
  updatePreview();
  initCharts(timeData, errorXData, errorYData, posXData, posYData, VData, WData);
};

function updatePreview() {
  if (!isAnimating) {
    const startX = parseFloat(document.getElementById('startX').value);
    const startY = parseFloat(document.getElementById('startY').value);
    const angle = parseFloat(document.getElementById('angle').value);
    robot.setInitialConditions(startX, startY, angle);
    const k = parseFloat(document.getElementById('k').value);
    const l = parseFloat(document.getElementById('l').value);
    const dt = parseFloat(document.getElementById('dt').value);
    robot.k = k;
    robot.l = l;
    robot.dt = dt;
    drawAllElements();
  }
}

function drawAllElements() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const actualWidth = canvas.width;
  const actualHeight = canvas.height;
  let scaleFactor = actualWidth / SIM_WIDTH;
  const cx = actualWidth / 2;
  const cy = actualHeight / 2;

  ctx.setTransform(scaleFactor, 0, 0, -scaleFactor, cx, cy);

  ctx.save();
  const grd = ctx.createLinearGradient(SIM_X_MIN, SIM_Y_MIN, SIM_X_MAX, SIM_Y_MAX);
  grd.addColorStop(0, '#ffffff');
  grd.addColorStop(1, '#f8f8f8');
  ctx.fillStyle = grd;
  ctx.fillRect(SIM_X_MIN, SIM_Y_MIN, SIM_WIDTH, SIM_HEIGHT);
  ctx.restore();

  drawGrid();
  drawTrajectory();
  drawRobot();
  drawPointsCircles();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawPointsLabels();

  updateRobotInfo();
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
  const startX = parseFloat(document.getElementById('startX').value);
  const startY = parseFloat(document.getElementById('startY').value);
  const endX = parseFloat(document.getElementById('endX').value);
  const endY = parseFloat(document.getElementById('endY').value);
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

  const startX = parseFloat(document.getElementById('startX').value);
  const startY = parseFloat(document.getElementById('startY').value);
  const endX = parseFloat(document.getElementById('endX').value);
  const endY = parseFloat(document.getElementById('endY').value);

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
    `Posición: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) | Ángulo: ${(robot.theta * 180 / Math.PI).toFixed(1)}°`;
}

function toggleAnimation() {
  if (isAnimating) {
    stopAnimation();
  } else {
    startAnimation();
  }
}

function startAnimation() {
  isAnimating = true;
  cycleCount = 0;
  timeData = [];
  errorXData = [];
  errorYData = [];
  posXData = [];
  posYData = [];
  VData = [];
  WData = [];
  document.getElementById('animateBtn').innerHTML = `<span id="animateIcon">&#10074;&#10074;</span> Pausa`;
  document.getElementById('angle').disabled = true;
  animate();
}

function stopAnimation() {
  isAnimating = false;
  cancelAnimationFrame(animationId);
  document.getElementById('animateBtn').innerHTML = `<span id="animateIcon">&#9658;</span> Iniciar`;
  document.getElementById('angle').disabled = false;
}

function resetAnimation() {
  stopAnimation();
  cycleCount = 0;
  document.getElementById('cycleCounter').textContent = `Ciclos: ${cycleCount} - Tiempo: 0.00 s`;
  timeData = [];
  errorXData = [];
  errorYData = [];
  posXData = [];
  posYData = [];
  VData = [];
  WData = [];
  const startX = parseFloat(document.getElementById('startX').value);
  const startY = parseFloat(document.getElementById('startY').value);
  const angle = parseFloat(document.getElementById('angle').value);
  robot.setInitialConditions(startX, startY, angle);
  drawAllElements();
  document.getElementById('animateBtn').innerHTML = `<span id="animateIcon">&#9658;</span> Iniciar`;
}

function animate() {
  cycleCount++;
  const t = cycleCount * robot.dt;
  document.getElementById('cycleCounter').textContent = `Ciclos: ${cycleCount} - Tiempo: ${t.toFixed(2)} s`;
  const endX = parseFloat(document.getElementById('endX').value);
  const endY = parseFloat(document.getElementById('endY').value);
  const { ex, ey, V, W } = robot.calculateControl(endX, endY);
  drawAllElements();
  timeData.push(parseFloat(t.toFixed(2)));
  errorXData.push(ex);
  errorYData.push(ey);
  posXData.push(robot.x);
  posYData.push(robot.y);
  VData.push(V);
  WData.push(W);
  updateCharts(timeData, errorXData, errorYData, posXData, posYData, VData, WData);
  animationId = requestAnimationFrame(animate);
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
