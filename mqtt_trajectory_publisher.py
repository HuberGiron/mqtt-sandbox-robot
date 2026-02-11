#python mqtt_trajectory_publisher.py --host test.mosquitto.org --port 1883 --topic huber/robot/goal --step 0.3 --period 50 --a 350 --b 200 --retain

import argparse
import json
import math
import time
from typing import Tuple

import paho.mqtt.client as mqtt


def ellipse_point(t: float, period: float, cx: float, cy: float, a: float, b: float) -> Tuple[float, float]:
    """Parametrización suave de elipse."""
    w = 2.0 * math.pi / period
    ang = w * t
    x = cx + a * math.cos(ang)
    y = cy + b * math.sin(ang)
    return x, y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="test.mosquitto.org")
    ap.add_argument("--port", type=int, default=1883)  # TCP MQTT
    ap.add_argument("--topic", default="huber/robot/goal")
    ap.add_argument("--qos", type=int, default=0, choices=[0, 1, 2])
    ap.add_argument("--step", type=float, default=0.10, help="segundos entre puntos publicados (>=0.2 recomendado)")
    ap.add_argument("--period", type=float, default=200.0, help="segundos para completar una vuelta")
    ap.add_argument("--cx", type=float, default=0.0)
    ap.add_argument("--cy", type=float, default=0.0)
    ap.add_argument("--a", type=float, default=350.0, help="radio en x (mm)")
    ap.add_argument("--b", type=float, default=200.0, help="radio en y (mm)")
    ap.add_argument("--retain", action="store_true", help="retener último objetivo (ideal para update inmediato al conectar)")
    ap.add_argument("--client_id", default=f"traj_pub_{int(time.time())}")
    args = ap.parse_args()

    client = mqtt.Client(client_id=args.client_id, clean_session=True)
    client.enable_logger()

    connected = {"ok": False}

    def on_connect(cl, userdata, flags, rc):
        connected["ok"] = (rc == 0)
        if rc == 0:
            print(f"[MQTT] Conectado a {args.host}:{args.port} | topic='{args.topic}'")
        else:
            print(f"[MQTT] Error connect rc={rc}")

    def on_disconnect(cl, userdata, rc):
        connected["ok"] = False
        print(f"[MQTT] Desconectado rc={rc}")

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

    client.connect(args.host, args.port, keepalive=30)
    client.loop_start()

    # Espera corta a conexión (sin bloquear eternamente)
    t0_wait = time.monotonic()
    while not connected["ok"] and (time.monotonic() - t0_wait) < 5.0:
        time.sleep(0.05)
    if not connected["ok"]:
        raise SystemExit("No se pudo conectar al broker en 5s.")

    # Publica un primer punto inmediato (útil con retain=True)
    seq = 0
    t0 = time.monotonic()
    next_tick = t0

    print(f"[PUB] step={args.step:.3f}s period={args.period:.1f}s ellipse a={args.a} b={args.b} center=({args.cx},{args.cy}) retain={args.retain}")

    try:
        while True:
            now = time.monotonic()
            if now < next_tick:
                time.sleep(next_tick - now)
                continue

            t = now - t0
            x, y = ellipse_point(t, args.period, args.cx, args.cy, args.a, args.b)

            # Payload compatible con tu parseGoalPayload: JSON con x,y (campos extra no molestan) :contentReference[oaicite:4]{index=4}
            payload = json.dumps({
                "x": round(x, 2),
                "y": round(y, 2),
                "seq": seq,
                "t_ms": int(time.time() * 1000)
            })

            client.publish(args.topic, payload=payload, qos=args.qos, retain=args.retain)
            seq += 1
            next_tick += args.step

    except KeyboardInterrupt:
        print("\n[CTRL+C] Saliendo...")
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
