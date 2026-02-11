#!/usr/bin/env python3
# llm_plan_mqtt.py
#
# Nodo LLM: toma instrucciones en español y publica al "PLANIFICADOR" por MQTT
# un comando JSON (goto/delta/stop/traj) para que éste genere puntos de trayectoria
# y los mande al robot virtual.
#
# Reqs:
#   pip install paho-mqtt requests
#
# Run:
#   python llm_plan_mqtt.py --cmd_topic huber/robot/plan/cmd

import argparse
import json
import re
import time
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

TRAJ_TYPES = [
    "line",
    "circle",
    "ellipse",
    "figure8",
    "sine",
    "square",
    "racetrack",
    "clothoid",
    "spiral",
    "spline",
    "astar",
    "rrtstar",
    "mpc",
]

JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": ["goto", "delta", "traj", "stop", "pause", "resume", "noop"]},
        "x": {"type": "number"},
        "y": {"type": "number"},
        "dx": {"type": "number"},
        "dy": {"type": "number"},
        "traj": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": TRAJ_TYPES},
                "dt": {"type": "number"},
                "period": {"type": "number"},
                "duration": {"type": "number"},
                "loops": {"type": "integer"},
                "center": {
                    "type": "object",
                    "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                    "required": ["x", "y"],
                    "additionalProperties": False,
                },
                "start": {
                    "type": "object",
                    "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                    "required": ["x", "y"],
                    "additionalProperties": False,
                },
                "end": {
                    "type": "object",
                    "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                    "required": ["x", "y"],
                    "additionalProperties": False,
                },
                "a": {"type": "number"},
                "b": {"type": "number"},
                "radius": {"type": "number"},
                "amp": {"type": "number"},
                "freq": {"type": "number"},
                "length": {"type": "number"},
                "speed": {"type": "number"},
                "waypoints": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
                        "required": ["x", "y"],
                        "additionalProperties": False,
                    },
                    "minItems": 2,
                    "maxItems": 50,
                },
            },
            "required": ["type"],
            "additionalProperties": False,
        },
    },
    "required": ["intent"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = f"""Eres un traductor de instrucciones en español a comandos para un PLANIFICADOR de trayectorias 2D.

Devuelve ÚNICAMENTE un objeto JSON válido que cumpla el schema proporcionado.
No incluyas texto extra, ni markdown, ni explicaciones.

Convenciones:
- Ejes: +x = derecha, -x = izquierda, +y = arriba/adelante, -y = abajo/atrás.
- Workspace:
  x ∈ [{X_MIN}, {X_MAX}]
  y ∈ [{Y_MIN}, {Y_MAX}]
- El planificador mantiene un "objetivo actual" (xg, yg). Si el usuario da órdenes relativas, usa intent="delta" con dx,dy.
- Si el usuario pide ir a un punto (centro, esquina, "x=...,y=..."), usa intent="goto" con x,y.
- Si el usuario pide una trayectoria, usa intent="traj" y llena "traj":
    - traj.type ∈ {TRAJ_TYPES}
    - Usa parámetros seguros por defecto si faltan:
        dt = 0.1 s (el planificador puede ignorarlo y usar su dt fijo)
        period = 30 s (círculo/elipse/figura8)
        speed = 150 mm/s (línea/waypoints)
        radius = 200 mm (círculo)
        a = 350 mm, b = 200 mm (elipse)
        amp = 120 mm, freq = 0.05 Hz (senoide)
    - Si no especifican centro, usa center=(0,0) salvo que tenga más sentido usar el objetivo actual.
    - Para "square" o "spline", si no te dan waypoints, genera una lista de 4 a 8 puntos dentro del workspace.
    - Para "astar/rrtstar/mpc": produce una trayectoria por waypoints (traj.type='astar' etc.) y coloca al menos end=(x,y) o waypoints.
- "stop" / "detener" => intent="stop".
- "pausa" => intent="pause", "continua" => intent="resume".
- Si es ambiguo, responde intent="noop".

Siempre procura que los valores queden dentro del workspace (si te sales, aproxima al límite).
"""


def ollama_generate(model: str, user_text: str, url: str, timeout_s: int = 60) -> Tuple[Optional[dict], str]:
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
        return json.loads(raw), raw
    except json.JSONDecodeError:
        return None, raw


# =========================
# Fallback (por si el LLM falla)
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

def fallback_cmd(text: str) -> dict:
    t = text.strip().lower()

    if any(w in t for w in ["stop", "deten", "alto", "parar"]):
        return {"intent": "stop"}

    if "pausa" in t:
        return {"intent": "pause"}
    if "continua" in t or "resume" in t:
        return {"intent": "resume"}

    if "centro" in t or "center" in t:
        return {"intent": "goto", "x": 0.0, "y": 0.0}

    if "circulo" in t or "círculo" in t:
        return {"intent": "traj", "traj": {"type": "circle", "center": {"x": 0.0, "y": 0.0}, "radius": 200.0, "period": 30.0}}
    if "elipse" in t:
        return {"intent": "traj", "traj": {"type": "ellipse", "center": {"x": 0.0, "y": 0.0}, "a": 350.0, "b": 200.0, "period": 40.0}}
    if "figura" in t and "8" in t:
        return {"intent": "traj", "traj": {"type": "figure8", "center": {"x": 0.0, "y": 0.0}, "a": 300.0, "b": 200.0, "period": 40.0}}
    if "seno" in t or "senoide" in t:
        return {"intent": "traj", "traj": {"type": "sine", "center": {"x": -300.0, "y": 0.0}, "amp": 120.0, "freq": 0.05, "speed": 120.0, "duration": 30.0}}
    if "cuadrad" in t:
        wp = [{"x": -300.0, "y": -200.0}, {"x": 300.0, "y": -200.0}, {"x": 300.0, "y": 200.0}, {"x": -300.0, "y": 200.0}, {"x": -300.0, "y": -200.0}]
        return {"intent": "traj", "traj": {"type": "square", "waypoints": wp, "speed": 150.0, "loops": 0}}

    # delta directions
    dist = _extract_number(t) or 100.0
    dx = dy = 0.0
    for w, (sx, sy) in DIR_WORDS.items():
        if w in t:
            dx += sx * dist
            dy += sy * dist
    if dx != 0.0 or dy != 0.0:
        return {"intent": "delta", "dx": dx, "dy": dy}

    # goto explicit
    m = re.search(r"x\s*=\s*(-?\d+(\.\d+)?)", t)
    n = re.search(r"y\s*=\s*(-?\d+(\.\d+)?)", t)
    if m and n:
        return {"intent": "goto", "x": float(m.group(1)), "y": float(n.group(1))}

    return {"intent": "noop"}


# =========================
# MQTT
# =========================
class MqttPub:
    def __init__(self, host: str, port: int, keepalive: int, client_id: str):
        self.host = host
        self.port = port
        self.keepalive = keepalive
        self.connected = False
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, clean_session=True)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        self.connected = (reason_code == 0)
        if self.connected:
            print(f"[MQTT] Conectado a {self.host}:{self.port}")
        else:
            print(f"[MQTT] Error connect reason_code={reason_code}")

    def _on_disconnect(self, client, userdata, reason_code, properties):
        self.connected = False
        print(f"[MQTT] Desconectado reason_code={reason_code}")

    def connect(self, timeout_s: float = 5.0):
        self.client.connect(self.host, self.port, keepalive=self.keepalive)
        self.client.loop_start()
        t0 = time.monotonic()
        while not self.connected and (time.monotonic() - t0) < timeout_s:
            time.sleep(0.05)
        if not self.connected:
            raise RuntimeError("No se pudo conectar al broker MQTT en 5s.")

    def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False):
        self.client.publish(topic, payload=payload, qos=qos, retain=retain)

    def close(self):
        try:
            self.client.loop_stop()
        finally:
            try:
                self.client.disconnect()
            except Exception:
                pass


def _clamp_cmd_inplace(cmd: dict) -> dict:
    """Clampa x/y/dx/dy y waypoints si vienen."""
    intent = cmd.get("intent")
    if intent == "goto":
        if "x" in cmd: cmd["x"] = clamp(float(cmd["x"]), X_MIN, X_MAX)
        if "y" in cmd: cmd["y"] = clamp(float(cmd["y"]), Y_MIN, Y_MAX)
    if intent == "traj":
        traj = cmd.get("traj") or {}
        if "center" in traj:
            traj["center"]["x"] = clamp(float(traj["center"]["x"]), X_MIN, X_MAX)
            traj["center"]["y"] = clamp(float(traj["center"]["y"]), Y_MIN, Y_MAX)
        for k in ("start", "end"):
            if k in traj:
                traj[k]["x"] = clamp(float(traj[k]["x"]), X_MIN, X_MAX)
                traj[k]["y"] = clamp(float(traj[k]["y"]), Y_MIN, Y_MAX)
        if "waypoints" in traj and isinstance(traj["waypoints"], list):
            for p in traj["waypoints"]:
                p["x"] = clamp(float(p["x"]), X_MIN, X_MAX)
                p["y"] = clamp(float(p["y"]), Y_MIN, Y_MAX)
        cmd["traj"] = traj
    return cmd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="test.mosquitto.org")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--cmd_topic", default="huber/robot/plan/cmd")
    ap.add_argument("--qos", type=int, default=0, choices=[0, 1, 2])
    ap.add_argument("--retain", action="store_true", help="Retener el último comando (útil si el planificador se reconecta)")
    ap.add_argument("--client_id", default=f"llm_plan_{int(time.time())}")

    ap.add_argument("--model", default="mistral-nemo:12b-instruct-2407-q4_0")
    ap.add_argument("--ollama_url", default=OLLAMA_URL_DEFAULT)
    ap.add_argument("--warmup", type=int, default=5)

    ap.add_argument("--once", default=None, help="Envía 1 comando y sale (ej: --once 'circulo 30s')")

    args = ap.parse_args()

    pub = MqttPub(args.host, args.port, keepalive=30, client_id=args.client_id)
    pub.connect()

    # Warmup: NO publica (similar a tu llm_goal_mqtt.py)
    warm_prompts = [
        "vete al centro",
        "derecha 100",
        "izquierda 100",
        "haz un circulo",
        "haz una elipse",
    ]
    print(f"\n[WARMUP] {args.warmup} corridas (NO publica). Model={args.model}")
    for i in range(args.warmup):
        txt = warm_prompts[i % len(warm_prompts)]
        cmd, raw = None, ""
        try:
            cmd, raw = ollama_generate(args.model, txt, args.ollama_url)
        except Exception as e:
            raw = f"ERROR: {e}"
        if not cmd:
            cmd = fallback_cmd(txt)
            why = f"fallback (LLM inválido). raw='{str(raw)[:100]}'"
        else:
            why = "LLM"
        cmd = _clamp_cmd_inplace(cmd)
        would_send = json.dumps({"cmd": cmd, "t_ms": int(time.time()*1000)}, ensure_ascii=False)
        print(f"  [{i+1}/{args.warmup}] '{txt}' -> {why} -> would_send: {would_send}")

    def send(text: str):
        cmd, raw = None, ""
        try:
            cmd, raw = ollama_generate(args.model, text, args.ollama_url)
        except Exception as e:
            raw = f"ERROR: {e}"

        if not cmd:
            cmd = fallback_cmd(text)
            why = f"fallback (LLM inválido). raw='{str(raw)[:100]}'"
        else:
            why = "LLM"

        cmd = _clamp_cmd_inplace(cmd)
        msg = {
            "cmd": cmd,
            "t_ms": int(time.time()*1000),
        }
        payload = json.dumps(msg, ensure_ascii=False)
        print(f"[PLAN] '{text}' -> {why}")
        print(f"[PUB ] topic='{args.cmd_topic}' retain={args.retain} qos={args.qos} payload={payload}")
        pub.publish(args.cmd_topic, payload, qos=args.qos, retain=args.retain)

    try:
        if args.once is not None:
            send(args.once)
            return

        print("\n[READY] Escribe un comando. 'exit' para salir.")
        print("Ejemplos:")
        print("  - 'derecha 100'")
        print("  - 'vete a la esquina superior derecha'")
        print("  - 'haz un círculo de radio 200 en 30s'")
        print("  - 'haz una figura 8 en el centro'")
        print("  - 'detener'\n")

        while True:
            s = input("> ").strip()
            if not s:
                continue
            if s.lower() in {"exit", "quit", "salir"}:
                break
            send(s)

    finally:
        pub.close()


if __name__ == "__main__":
    main()
