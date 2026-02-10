#python publish_goal.py --topic huber/robot/goal --x 150 --y -80 --format json
#python publish_goal.py --topic huber/robot/goal

import argparse
import json
import sys
import time

import paho.mqtt.client as mqtt


def build_payload(x: float, y: float, fmt: str) -> str:
    if fmt == "json":
        return json.dumps({"x": x, "y": y}, separators=(",", ":"))
    if fmt == "csv":
        return f"{x},{y}"
    raise ValueError("fmt must be 'json' or 'csv'")


def publish_once(args) -> None:
    # transport: "tcp" (normal) o "websockets" (para ws/wss)
    transport = "websockets" if args.ws else "tcp"
    client = mqtt.Client(client_id=args.client_id or "", transport=transport)

    if args.username is not None:
        client.username_pw_set(args.username, args.password)

    # Si usas wss (TLS), activa TLS
    if args.tls:
        client.tls_set()  # usa CA del sistema

    # Si usas websockets, define el path (típicamente /mqtt)
    if args.ws:
        client.ws_set_options(path=args.ws_path)

    client.connect(args.host, args.port, keepalive=30)
    client.loop_start()

    payload = build_payload(args.x, args.y, args.format)
    info = client.publish(args.topic, payload=payload, qos=args.qos, retain=args.retain)
    info.wait_for_publish()

    client.loop_stop()
    client.disconnect()


def interactive(args) -> None:
    print(f"Publicando a topic: {args.topic}")
    print("Escribe: x y   (ej. 120 -50)  |  'q' para salir")
    while True:
        line = input("> ").strip()
        if line.lower() in ("q", "quit", "exit"):
            break
        try:
            parts = line.replace(",", " ").split()
            if len(parts) != 2:
                print("Formato inválido. Usa: x y")
                continue
            x, y = float(parts[0]), float(parts[1])
            args.x, args.y = x, y
            publish_once(args)
            print(f"OK -> publicado ({x}, {y})")
        except Exception as e:
            print(f"Error: {e}")


def main():
    p = argparse.ArgumentParser(description="Publica (Xs, Ys) a un tópico MQTT para tu simulación.")
    p.add_argument("--topic", default="huber/robot/goal", help="Tópico MQTT (default: huber/robot/goal)")
    p.add_argument("--format", choices=["json", "csv"], default="json", help="Formato del mensaje")
    p.add_argument("--qos", type=int, choices=[0, 1, 2], default=0)
    p.add_argument("--retain", action="store_true", help="Publicar con retain=True")

    # Opción A: MQTT TCP normal (recomendado)
    p.add_argument("--host", default="test.mosquitto.org", help="Broker host")
    p.add_argument("--port", type=int, default=1883, help="Puerto (TCP default: 1883)")

    # Opción B: WebSockets (ws/wss), útil si tu red bloquea 1883
    p.add_argument("--ws", action="store_true", help="Usar WebSockets (transport=websockets)")
    p.add_argument("--ws-path", default="/mqtt", help="Path WebSocket (default: /mqtt)")
    p.add_argument("--tls", action="store_true", help="Habilitar TLS (para wss)")

    p.add_argument("--username", default=None)
    p.add_argument("--password", default=None)
    p.add_argument("--client-id", default=None)

    p.add_argument("--x", type=float, default=None, help="Objetivo Xs")
    p.add_argument("--y", type=float, default=None, help="Objetivo Ys")

    args = p.parse_args()

    # Si no pasan x,y => modo interactivo
    if args.x is None or args.y is None:
        interactive(args)
    else:
        publish_once(args)
        print("OK")


if __name__ == "__main__":
    main()
