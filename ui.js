// ui.js
// Compatible con tu index.html actual:
// - Radios: input[name="targetSource"] con value="manual" | "mqtt"
// - Inputs manuales objetivo: #endX y #endY
// - Panel MQTT: #mqttPanel
// - Controles manuales dentro del primer <details> de .info-boxes (sin id)

(() => {
  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Elementos según tu HTML
  const manualRadio = q('input[name="targetSource"][value="manual"]');
  const mqttRadio = q('input[name="targetSource"][value="mqtt"]');
  const radios = qa('input[name="targetSource"]');

  const mqttPanel = document.getElementById("mqttPanel");

  // Objetivo manual (inputs dentro de <details>)
  const endX = document.getElementById("endX");
  const endY = document.getElementById("endY");

  // <details> donde están los controles de simulación (el primero dentro de .info-boxes)
  const controlsDetails =
    document.getElementById("controlsPanel") || q("section.info-boxes details");

  function setDisabled(el, disabled) {
    if (!el) return;
    el.disabled = !!disabled;
    el.setAttribute("aria-disabled", disabled ? "true" : "false");
  }

  function show(el, visible) {
    if (!el) return;
    el.style.display = visible ? "" : "none";
    el.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function getMode() {
    return mqttRadio && mqttRadio.checked ? "mqtt" : "manual";
  }

  function applyMode(mode) {
    const isMQTT = mode === "mqtt";

    // Panel MQTT visible solo en modo MQTT
    show(mqttPanel, isMQTT);

    // Inputs manuales objetivo deshabilitados en MQTT
    setDisabled(endX, isMQTT);
    setDisabled(endY, isMQTT);

    // Mantén controles manuales ocultos por default.
    // Solo forzamos cerrar el details cuando cambias a MQTT.
    if (controlsDetails && isMQTT) {
      controlsDetails.open = false;
    }
  }

  function wireEvents() {
    if (!radios.length) return;
    radios.forEach((r) => {
      r.addEventListener("change", () => applyMode(getMode()));
    });
  }

  function init() {
    wireEvents();
    applyMode(getMode());
  }

  // DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
