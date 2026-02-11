#python llm_goal_mqtt.py --topic huber/robot/goal

#!/usr/bin/env python3
# llm_goal_mqtt.py
#
# Convierte instrucciones en español (derecha/izquierda/adelante/atrás/centro/esquinas)
# a una nueva meta (x,y) y la publica por MQTT como JSON {"x":..,"y":..,"seq":..,"t_ms":..}.
#
# - Warmup (default=5): llama al LLM pero NO publica. Solo imprime lo que *habría* enviado.
# - Luego: o envía una sola vez (--once "comando") o entra en modo interactivo.
#
# Reqs:
#   pip install paho-mqtt requests

import argparse
import json
import re
import time
from dataclasses import dataclass
from typing import Optional, Tuple

import requests
import paho.mqtt.client as mqtt


# =========================
# Workspace (mm)
# =========================
X_MIN, X_MAX = -500.0, 500.0
Y_MIN, Y_MAX = -300.0, 300.0


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


# =========================
# Ollama config + schema
# =========================
OLLAMA_URL_DEFAULT = "http://localhost:11434/api/generate"

# Schema simple (sin condiciones) para que Ollama no “pelee”:
# intent:
#   - "goto": usar x,y absolutos
#   - "delta": usar dx,dy relativos al goal actual
#   - "noop": no cambiar
JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": ["goto", "delta", "noop"]},
        "x": {"type": "number"},
        "y": {"type": "number"},
        "dx": {"type": "number"},
        "dy": {"type": "number"},
    },
    "required": ["intent"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = f"""Eres un traductor de instrucciones a objetivos 2D (x,y) para un robot virtual.
Devuelve ÚNICAMENTE un objeto JSON válido que cumpla el schema proporcionado.
No incluyas texto extra, ni markdown, ni explicaciones.

Convenciones:
- Ejes: +x = derecha, -x = izquierda, +y = arriba/adelante, -y = abajo/atrás.
- Espacio de trabajo:
  x ∈ [{X_MIN}, {X_MAX}]
  y ∈ [{Y_MIN}, {Y_MAX}]
- Tienes un "goal actual" (xg, yg). Instrucciones relativas (derecha/izquierda/arriba/abajo/adelante/atrás)
  deben usarse con intent="delta" y (dx,dy). Instrucciones absolutas (centro, esquina, ve a x=...,y=...)
  deben usarse con intent="goto" y (x,y).
- Distancia por defecto si el usuario no indica: 100 (mm).
- "centro" => goto (0,0).
- "esquina derecha" => goto (x=500, y=300) por defecto (arriba-derecha), salvo que se especifique "inferior".
- Si es ambiguo, elige un movimiento seguro: intent="noop" o delta pequeño (dx/dy=50).

Siempre procura que el resultado quede dentro del workspace (si te sales, aproxima al límite).
"""


def ollama_generate(
    model: str,
    user_text: str,
    url: str = OLLAMA_URL_DEFAULT,
    timeout_s: int = 60,
) -> Tuple[Optional[dict], str]:
    payload = {
        "model": model,
        "system": SYSTEM_PROMPT,
        "prompt": user_text,
        "stream": False,
        "format": JSON_SCHEMA,
        "options": {"temperature": 0},
    }
    r = requests.post(url, json=payload, timeout=timeout_s)
    r.raise_for_status()
    data = r.json()

    raw = (data.get("response") or "").strip()
    if not raw:
        return None, raw

    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        obj = None
    return obj, raw


# =========================
# Fallback parser (si LLM falla)
# =========================
DIR_WORDS = {
    "derecha": (1, 0),
    "izquierda": (-1, 0),
    "arriba": (0, 1),
    "abajo": (0, -1),
    "adelante": (0, 1),
    "atras": (0, -1),
    "atrás": (0, -1),
}

def _extract_number(text: str) -> Optional[float]:
    m = re.search(r"(-?\d+(\.\d+)?)", text)
    return float(m.group(1)) if m else None

def fallback_plan(text: str, gx: float, gy: float) -> Tuple[float, float, str]:
    t = text.strip().lower()

    # centro
    if "centro" in t or "center" in t:
        return 0.0, 0.0, "fallback: centro->goto(0,0)"

    # esquinas
    is_inf = ("inferior" in t) or ("abajo" in t)
    is_sup = ("superior" in t) or ("arriba" in t)
    is_izq = ("izquierda" in t) or ("izq" in t)
    is_der = ("derecha" in t) or ("der" in t)

    if "esquina" in t:
        x = X_MIN if is_izq and not is_der else X_MAX if is_der and not is_izq else X_MAX
        y = Y_MIN if is_inf and not is_sup else Y_MAX if is_sup and not is_inf else Y_MAX
        return x, y, f"fallback: esquina->goto({x},{y})"

    # delta por direcciones
    dist = _extract_number(t) or 100.0
    dx = dy = 0.0
    for w, (sx, sy) in DIR_WORDS.items():
        if w in t:
            dx += sx * dist
            dy += sy * dist

    if dx == 0.0 and dy == 0.0:
        return gx, gy, "fallback: noop"

    return gx + dx, gy + dy, f"fallback: delta(dx={dx},dy={dy})"


# =========================
# MQTT helper (similar a tu estilo)
# =========================
class MqttConn:
    def __init__(self, host: str, port: int, keepalive: int, client_id: str):
        self.host = host
        self.port = port
        self.keepalive = keepalive
        self.client = mqtt.Client(client_id=client_id, clean_session=True)
        self.connected = False
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

    def _on_connect(self, cl, userdata, flags, rc):
        self.connected = (rc == 0)
        if rc == 0:
            print(f"[MQTT] Conectado a {self.host}:{self.port}")
        else:
            print(f"[MQTT] Error connect rc={rc}")

    def _on_disconnect(self, cl, userdata, rc):
        self.connected = False
        print(f"[MQTT] Desconectado rc={rc}")

    def connect(self, timeout_s: float = 5.0):
        self.client.connect(self.host, self.port, keepalive=self.keepalive)
        self.client.loop_start()
        t0 = time.monotonic()
        while not self.connected and (time.monotonic() - t0) < timeout_s:
            time.sleep(0.05)
        if not self.connected:
            raise RuntimeError("No se pudo conectar al broker MQTT en 5s.")

    def publish(self, topic: str, payload: str, qos: int, retain: bool):
        self.client.publish(topic, payload=payload, qos=qos, retain=retain)

    def close(self):
        try:
            self.client.loop_stop()
        finally:
            try:
                self.client.disconnect()
            except Exception:
                pass


@dataclass
class GoalState:
    x: float = 0.0
    y: float = 0.0
    seq: int = 0


def plan_goal_with_llm(text: str, model: str, url: str, gx: float, gy: float) -> Tuple[Optional[float], Optional[float], str]:
    prompt = (
        f'Instrucción del usuario: "{text}"\n'
        f"Goal actual (xg,yg)=({gx:.2f},{gy:.2f})\n"
        f"Workspace: x∈[{X_MIN},{X_MAX}], y∈[{Y_MIN},{Y_MAX}]\n"
        "Devuelve SOLO el JSON.\n"
    )
    obj, raw = ollama_generate(model=model, user_text=prompt, url=url)
    if not obj or "intent" not in obj:
        return None, None, f"LLM inválido. raw='{raw[:120]}'"

    intent = obj.get("intent")
    if intent == "noop":
        return gx, gy, "LLM: noop"

    if intent == "goto":
        x = obj.get("x", gx)
        y = obj.get("y", gy)
        return float(x), float(y), f"LLM: goto(x={x},y={y})"

    if intent == "delta":
        dx = obj.get("dx", 0.0)
        dy = obj.get("dy", 0.0)
        return gx + float(dx), gy + float(dy), f"LLM: delta(dx={dx},dy={dy})"

    return None, None, f"LLM intent desconocido. raw='{raw[:120]}'"


def build_goal_payload(x: float, y: float, seq: int, y_positive: str) -> str:
    # Si tu simulador usa y positivo hacia abajo, invertimos antes de publicar
    y_out = y if y_positive == "up" else -y
    payload = json.dumps({
        "x": round(x, 2),
        "y": round(y_out, 2),
        "seq": seq,
        "t_ms": int(time.time() * 1000),
    })
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="test.mosquitto.org")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--topic", required=True, help="Tópico MQTT donde tu robot escucha el goal (ej: huber/robot/goal)")
    ap.add_argument("--qos", type=int, default=0, choices=[0, 1, 2])
    ap.add_argument("--retain", dest="retain", action="store_true", help="Retener último goal (útil para update inmediato al conectar)")
    ap.add_argument("--no-retain", dest="retain", action="store_false", help="No retener")
    ap.set_defaults(retain=True)

    ap.add_argument("--model", default="mistral-nemo:12b-instruct-2407-q4_0")
    ap.add_argument("--ollama_url", default=OLLAMA_URL_DEFAULT)
    ap.add_argument("--warmup", type=int, default=5)

    ap.add_argument("--y_positive", choices=["up", "down"], default="up", help="Convención de tu simulador al PUBLICAR")
    ap.add_argument("--once", default=None, help="Envía solo 1 comando y sale (ej: --once 'derecha 100')")

    ap.add_argument("--client_id", default=f"llm_goal_{int(time.time())}")
    args = ap.parse_args()

    # Conexión MQTT
    conn = MqttConn(args.host, args.port, keepalive=30, client_id=args.client_id)
    conn.connect()

    # Warmup (NO publica)
    print(f"\n[WARMUP] {args.warmup} corridas (NO publica). Model={args.model}")
    dummy = GoalState(0.0, 0.0, 0)
    warm_prompts = ["centro", "derecha 100", "izquierda 100", "arriba 100", "abajo 100"]
    for i in range(args.warmup):
        txt = warm_prompts[i % len(warm_prompts)]
        x_llm, y_llm, why = plan_goal_with_llm(txt, args.model, args.ollama_url, dummy.x, dummy.y)
        if x_llm is None or y_llm is None:
            x_llm, y_llm, why = (*fallback_plan(txt, dummy.x, dummy.y)[:2], fallback_plan(txt, dummy.x, dummy.y)[2])
        dummy.x = clamp(x_llm, X_MIN, X_MAX)
        dummy.y = clamp(y_llm, Y_MIN, Y_MAX)
        payload = build_goal_payload(dummy.x, dummy.y, dummy.seq, args.y_positive)
        print(f"  [{i+1}/{args.warmup}] '{txt}' -> {why} -> would_send: {payload}")
        dummy.seq += 1

    # Estado real del goal (reinicia en centro tras warmup)
    st = GoalState(0.0, 0.0, 0)

    def send_command(user_text: str):
        nonlocal st
        x_llm, y_llm, why = plan_goal_with_llm(user_text, args.model, args.ollama_url, st.x, st.y)

        if x_llm is None or y_llm is None:
            x_llm, y_llm, why = fallback_plan(user_text, st.x, st.y)

        # Clamp a workspace
        x_new = clamp(float(x_llm), X_MIN, X_MAX)
        y_new = clamp(float(y_llm), Y_MIN, Y_MAX)

        payload = build_goal_payload(x_new, y_new, st.seq, args.y_positive)
        print(f"[PLAN] '{user_text}' -> {why}")
        print(f"[PUB ] topic='{args.topic}' retain={args.retain} qos={args.qos} payload={payload}")

        conn.publish(args.topic, payload, qos=args.qos, retain=args.retain)

        st.x, st.y = x_new, y_new
        st.seq += 1

    try:
        if args.once is not None:
            send_command(args.once)
            return

        print("\n[READY] Escribe un comando (ENTER para enviar). 'exit' para salir.")
        print("Ejemplos: 'derecha 100', 'adelante 50', 'vete al centro', 'esquina inferior izquierda'\n")
        while True:
            s = input("> ").strip()
            if not s:
                continue
            if s.lower() in {"exit", "quit", "salir"}:
                break
            send_command(s)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
