#!/usr/bin/env python3
# planner_mqtt.py
#
# PLANIFICADOR: se suscribe a un tópico de comandos (LLM->planner) y publica
# objetivos (x,y) al robot virtual en tiempo real (default dt=0.1s).
#
# Reqs:
#   pip install paho-mqtt
#
# Run:
#   python planner_mqtt.py --cmd_topic huber/robot/plan/cmd --goal_topic huber/robot/goal --dt 0.1

import argparse
import json
import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import paho.mqtt.client as mqtt


# =========================
# Workspace (mm)
# =========================
X_MIN, X_MAX = -500.0, 500.0
Y_MIN, Y_MAX = -300.0, 300.0


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def clamp_xy(x: float, y: float) -> Tuple[float, float]:
    return clamp(x, X_MIN, X_MAX), clamp(y, Y_MIN, Y_MAX)


def now_ms() -> int:
    return int(time.time() * 1000)


# =========================
# Trajectory primitives
# =========================
class Trajectory:
    """Base: sample(t) -> (x,y,done). t is seconds since start."""
    def __init__(self):
        self.t0 = 0.0
        self.x0 = 0.0
        self.y0 = 0.0

    def reset(self, start_xy: Tuple[float, float], t0: float):
        self.x0, self.y0 = start_xy
        self.t0 = t0

    def sample(self, t: float) -> Tuple[float, float, bool]:
        return self.x0, self.y0, False


class Hold(Trajectory):
    def __init__(self, target_xy: Tuple[float, float]):
        super().__init__()
        self.tx, self.ty = target_xy

    def reset(self, start_xy: Tuple[float, float], t0: float):
        super().reset(start_xy, t0)

    def sample(self, t: float):
        return self.tx, self.ty, False


class LineTo(Trajectory):
    def __init__(self, target_xy: Tuple[float, float], speed: float = 150.0):
        super().__init__()
        self.tx, self.ty = target_xy
        self.speed = max(1e-3, float(speed))
        self.dist = 0.0
        self.vx = 0.0
        self.vy = 0.0

    def reset(self, start_xy: Tuple[float, float], t0: float):
        super().reset(start_xy, t0)
        dx = self.tx - self.x0
        dy = self.ty - self.y0
        self.dist = math.hypot(dx, dy)
        if self.dist < 1e-6:
            self.vx = self.vy = 0.0
        else:
            self.vx = dx / self.dist
            self.vy = dy / self.dist

    def sample(self, t: float):
        if self.dist < 1e-6:
            return self.tx, self.ty, True
        s = self.speed * t
        if s >= self.dist:
            return self.tx, self.ty, True
        x = self.x0 + self.vx * s
        y = self.y0 + self.vy * s
        return x, y, False


class Circle(Trajectory):
    def __init__(self, center: Tuple[float, float], radius: float = 200.0, period: float = 30.0, loops: int = 0):
        super().__init__()
        self.cx, self.cy = center
        self.r = abs(float(radius))
        self.period = max(1e-3, float(period))
        self.loops = int(loops)

    def sample(self, t: float):
        w = 2.0 * math.pi / self.period
        ang = w * t
        x = self.cx + self.r * math.cos(ang)
        y = self.cy + self.r * math.sin(ang)
        done = (self.loops > 0) and (t >= self.loops * self.period)
        return x, y, done


class Ellipse(Trajectory):
    def __init__(self, center: Tuple[float, float], a: float = 350.0, b: float = 200.0, period: float = 40.0, loops: int = 0):
        super().__init__()
        self.cx, self.cy = center
        self.a = abs(float(a))
        self.b = abs(float(b))
        self.period = max(1e-3, float(period))
        self.loops = int(loops)

    def sample(self, t: float):
        w = 2.0 * math.pi / self.period
        ang = w * t
        x = self.cx + self.a * math.cos(ang)
        y = self.cy + self.b * math.sin(ang)
        done = (self.loops > 0) and (t >= self.loops * self.period)
        return x, y, done


class Figure8(Trajectory):
    """Lissajous simple: x = cx + a*sin(w t), y = cy + b*sin(2 w t)."""
    def __init__(self, center: Tuple[float, float], a: float = 300.0, b: float = 200.0, period: float = 40.0, loops: int = 0):
        super().__init__()
        self.cx, self.cy = center
        self.a = abs(float(a))
        self.b = abs(float(b))
        self.period = max(1e-3, float(period))
        self.loops = int(loops)

    def sample(self, t: float):
        w = 2.0 * math.pi / self.period
        x = self.cx + self.a * math.sin(w * t)
        y = self.cy + self.b * math.sin(2.0 * w * t)
        done = (self.loops > 0) and (t >= self.loops * self.period)
        return x, y, done


class Sine(Trajectory):
    """Senoide con avance en x: x = x_start + speed*t, y = cy + amp*sin(2π f t)."""
    def __init__(self, center: Tuple[float, float], amp: float = 120.0, freq: float = 0.05, speed: float = 120.0, duration: float = 30.0):
        super().__init__()
        self.cx, self.cy = center
        self.amp = abs(float(amp))
        self.freq = max(0.0, float(freq))
        self.speed = float(speed)  # puede ser negativa
        self.duration = max(1e-3, float(duration))

    def reset(self, start_xy: Tuple[float, float], t0: float):
        # usamos el start x como referencia si no te dan center.x
        super().reset(start_xy, t0)
        if self.cx is None:
            self.cx = self.x0

    def sample(self, t: float):
        x = self.cx + self.speed * t
        y = self.cy + self.amp * math.sin(2.0 * math.pi * self.freq * t)
        done = t >= self.duration
        return x, y, done


class Waypoints(Trajectory):
    """Recorre una lista de waypoints a velocidad constante. loops=0 => infinito si el path es cerrado."""
    def __init__(self, waypoints: List[Tuple[float, float]], speed: float = 150.0, loops: int = 1, closed_hint: Optional[bool] = None):
        super().__init__()
        if len(waypoints) < 2:
            raise ValueError("Waypoints requieren al menos 2 puntos")
        self.wp = waypoints
        self.speed = max(1e-3, float(speed))
        self.loops = int(loops)
        self.closed = bool(closed_hint) if closed_hint is not None else (math.hypot(waypoints[0][0]-waypoints[-1][0], waypoints[0][1]-waypoints[-1][1]) < 1e-6)

        # precompute segment lengths
        self.seg = []
        self.cum = [0.0]
        total = 0.0
        for i in range(len(waypoints)-1):
            x0,y0 = waypoints[i]
            x1,y1 = waypoints[i+1]
            L = math.hypot(x1-x0, y1-y0)
            self.seg.append(L)
            total += L
            self.cum.append(total)
        self.total = total if total > 1e-6 else 1e-6

    def sample(self, t: float):
        s = self.speed * t  # mm
        if self.loops <= 0:
            # infinito: si cerrado, cicla; si no, se queda al final
            if self.closed:
                s = s % self.total
            else:
                s = min(s, self.total)
        else:
            if s >= self.loops * self.total:
                # terminado
                x,y = self.wp[-1]
                return x, y, True
            # dentro de loops
            s = s % self.total

        # encontrar segmento
        # cum[k] <= s < cum[k+1]
        k = 0
        while k < len(self.seg) and self.cum[k+1] < s:
            k += 1
        k = min(k, len(self.seg)-1)

        s0 = self.cum[k]
        L = max(1e-6, self.seg[k])
        u = (s - s0) / L
        x0,y0 = self.wp[k]
        x1,y1 = self.wp[k+1]
        x = x0 + u*(x1-x0)
        y = y0 + u*(y1-y0)
        return x, y, False


class Racetrack(Trajectory):
    """Pista: recta + semicirc. Parametrizada por longitud de arco."""
    def __init__(self, center: Tuple[float,float], straight: float = 400.0, radius: float = 120.0, speed: float = 150.0, loops: int = 0):
        super().__init__()
        self.cx, self.cy = center
        self.straight = abs(float(straight))
        self.r = abs(float(radius))
        self.speed = max(1e-3, float(speed))
        self.loops = int(loops)
        # perimeter approx
        self.total = 2.0*self.straight + 2.0*math.pi*self.r

    def sample(self, t: float):
        s = self.speed * t
        if self.loops > 0 and s >= self.loops * self.total:
            # finish at start
            return self.cx + self.straight/2.0, self.cy + self.r, True

        if self.loops <= 0:
            s = s % self.total
        else:
            s = s % self.total

        # Segment order: top straight (right->left), left semicircle (top->bottom), bottom straight (left->right), right semicircle (bottom->top)
        # Define key points:
        xR = self.cx + self.straight/2.0
        xL = self.cx - self.straight/2.0
        yT = self.cy + self.r
        yB = self.cy - self.r

        if s < self.straight:
            # top straight: from (xR,yT) to (xL,yT)
            u = s / self.straight
            x = xR + u*(xL - xR)
            y = yT
            return x, y, False
        s -= self.straight

        arc = math.pi * self.r
        if s < arc:
            # left semicircle: angle from 90deg to 270deg
            ang = math.pi/2.0 + (s/arc)*math.pi
            x = xL + self.r*math.cos(ang)
            y = self.cy + self.r*math.sin(ang)
            return x, y, False
        s -= arc

        if s < self.straight:
            # bottom straight: (xL,yB) -> (xR,yB)
            u = s / self.straight
            x = xL + u*(xR - xL)
            y = yB
            return x, y, False
        s -= self.straight

        # right semicircle: angle from 270deg to 90deg
        ang = 3.0*math.pi/2.0 + (s/arc)*math.pi
        x = xR + self.r*math.cos(ang)
        y = self.cy + self.r*math.sin(ang)
        return x, y, False


class Clothoid(Trajectory):
    """Clotoide por integración numérica: curvatura k = k_rate * s."""
    def __init__(self, k_rate: float = 1e-5, speed: float = 120.0, duration: float = 30.0):
        super().__init__()
        self.k_rate = float(k_rate)
        self.speed = max(1e-3, float(speed))
        self.duration = max(1e-3, float(duration))
        self._last_t = 0.0
        self._x = 0.0
        self._y = 0.0
        self._theta = 0.0
        self._s = 0.0

    def reset(self, start_xy: Tuple[float,float], t0: float):
        super().reset(start_xy, t0)
        self._last_t = 0.0
        self._x, self._y = start_xy
        self._theta = 0.0
        self._s = 0.0

    def sample(self, t: float):
        # integrate from last_t to t in small steps to keep stable
        dt = t - self._last_t
        if dt <= 0.0:
            return self._x, self._y, (t >= self.duration)

        steps = max(1, int(dt / 0.02))  # integrate at ~50Hz internal
        h = dt / steps
        for _ in range(steps):
            ds = self.speed * h
            self._s += ds
            k = self.k_rate * self._s
            self._theta += k * ds
            self._x += math.cos(self._theta) * ds
            self._y += math.sin(self._theta) * ds

        self._last_t = t
        done = t >= self.duration
        return self._x, self._y, done


class Spiral(Trajectory):
    """Espiral arquimediana: r = r0 + k*theta."""
    def __init__(self, center: Tuple[float,float], r0: float = 20.0, k: float = 10.0, period: float = 30.0, duration: float = 30.0):
        super().__init__()
        self.cx, self.cy = center
        self.r0 = abs(float(r0))
        self.k = float(k)
        self.period = max(1e-3, float(period))
        self.duration = max(1e-3, float(duration))

    def sample(self, t: float):
        w = 2.0 * math.pi / self.period
        theta = w * t
        r = self.r0 + self.k * theta
        x = self.cx + r * math.cos(theta)
        y = self.cy + r * math.sin(theta)
        done = t >= self.duration
        return x, y, done


def catmull_rom(p0, p1, p2, p3, u: float) -> Tuple[float,float]:
    # u in [0,1]
    u2 = u*u
    u3 = u2*u
    x = 0.5 * ((2*p1[0]) + (-p0[0] + p2[0])*u + (2*p0[0] - 5*p1[0] + 4*p2[0] - p3[0])*u2 + (-p0[0] + 3*p1[0] - 3*p2[0] + p3[0])*u3)
    y = 0.5 * ((2*p1[1]) + (-p0[1] + p2[1])*u + (2*p0[1] - 5*p1[1] + 4*p2[1] - p3[1])*u2 + (-p0[1] + 3*p1[1] - 3*p2[1] + p3[1])*u3)
    return x,y


class SplinePath(Trajectory):
    """Catmull-Rom sobre waypoints. Se recorre por tiempo (duration) o por velocidad aproximada."""
    def __init__(self, waypoints: List[Tuple[float,float]], duration: float = 30.0):
        super().__init__()
        if len(waypoints) < 2:
            raise ValueError("Spline requiere >=2 waypoints")
        self.wp = waypoints
        self.duration = max(1e-3, float(duration))
        self.nseg = len(waypoints) - 1

    def sample(self, t: float):
        if t >= self.duration:
            x,y = self.wp[-1]
            return x,y, True

        # map t -> segment
        s = (t / self.duration) * self.nseg
        i = int(math.floor(s))
        u = s - i
        i = max(0, min(i, self.nseg - 1))

        # indices with clamping
        p1 = self.wp[i]
        p2 = self.wp[i+1]
        p0 = self.wp[i-1] if i-1 >= 0 else p1
        p3 = self.wp[i+2] if i+2 < len(self.wp) else p2

        x,y = catmull_rom(p0,p1,p2,p3,u)
        return x,y, False


# =========================
# Planner state + command handling
# =========================
@dataclass
class PlannerState:
    x: float = 0.0
    y: float = 0.0
    seq: int = 0
    mode: str = "hold"   # hold/traj/stop
    paused: bool = False
    traj: Optional[Trajectory] = None
    traj_started_ms: int = 0


def build_goal_payload(x: float, y: float, seq: int, y_positive: str) -> str:
    y_out = y if y_positive == "up" else -y
    return json.dumps({
        "x": round(x, 2),
        "y": round(y_out, 2),
        "seq": seq,
        "t_ms": now_ms(),
    })


def _safe_get_xy(obj: Any, default_xy: Tuple[float,float]) -> Tuple[float,float]:
    if isinstance(obj, dict) and "x" in obj and "y" in obj:
        return float(obj["x"]), float(obj["y"])
    return default_xy


def _mk_traj(traj_dict: Dict[str, Any], start_xy: Tuple[float,float]) -> Trajectory:
    ttype = (traj_dict.get("type") or "").lower().strip()

    # Defaults
    cx, cy = _safe_get_xy(traj_dict.get("center"), (0.0, 0.0))
    cx, cy = clamp_xy(cx, cy)

    if ttype == "line":
        end = _safe_get_xy(traj_dict.get("end"), start_xy)
        end = clamp_xy(*end)
        speed = float(traj_dict.get("speed", 150.0))
        return LineTo(end, speed=speed)

    if ttype == "circle":
        r = float(traj_dict.get("radius", 200.0))
        period = float(traj_dict.get("period", 30.0))
        loops = int(traj_dict.get("loops", 0))
        # keep inside workspace conservatively
        r = min(r, min((X_MAX - X_MIN)/2.0 - 10.0, (Y_MAX - Y_MIN)/2.0 - 10.0))
        return Circle((cx, cy), radius=r, period=period, loops=loops)

    if ttype == "ellipse":
        a = float(traj_dict.get("a", 350.0))
        b = float(traj_dict.get("b", 200.0))
        period = float(traj_dict.get("period", 40.0))
        loops = int(traj_dict.get("loops", 0))
        a = min(abs(a), (X_MAX - X_MIN)/2.0 - 10.0)
        b = min(abs(b), (Y_MAX - Y_MIN)/2.0 - 10.0)
        return Ellipse((cx, cy), a=a, b=b, period=period, loops=loops)

    if ttype == "figure8":
        a = float(traj_dict.get("a", 300.0))
        b = float(traj_dict.get("b", 200.0))
        period = float(traj_dict.get("period", 40.0))
        loops = int(traj_dict.get("loops", 0))
        a = min(abs(a), (X_MAX - X_MIN)/2.0 - 10.0)
        b = min(abs(b), (Y_MAX - Y_MIN)/2.0 - 10.0)
        return Figure8((cx, cy), a=a, b=b, period=period, loops=loops)

    if ttype == "sine":
        amp = float(traj_dict.get("amp", 120.0))
        freq = float(traj_dict.get("freq", 0.05))
        speed = float(traj_dict.get("speed", 120.0))
        duration = float(traj_dict.get("duration", 30.0))
        amp = min(abs(amp), (Y_MAX - Y_MIN)/2.0 - 10.0)
        # If center not provided, use start point x as center.x and y0 as center.y
        if "center" not in traj_dict:
            cx, cy = start_xy
        return Sine((cx, cy), amp=amp, freq=freq, speed=speed, duration=duration)

    if ttype in ("square",):
        # default square if no waypoints
        wps = traj_dict.get("waypoints")
        if not isinstance(wps, list) or len(wps) < 2:
            wps = [
                {"x": -300.0, "y": -200.0},
                {"x":  300.0, "y": -200.0},
                {"x":  300.0, "y":  200.0},
                {"x": -300.0, "y":  200.0},
                {"x": -300.0, "y": -200.0},
            ]
        wp_xy = [clamp_xy(float(p["x"]), float(p["y"])) for p in wps]
        speed = float(traj_dict.get("speed", 150.0))
        loops = int(traj_dict.get("loops", 0))
        return Waypoints(wp_xy, speed=speed, loops=loops, closed_hint=True)

    if ttype == "racetrack":
        straight = float(traj_dict.get("length", 400.0))
        r = float(traj_dict.get("radius", 120.0))
        speed = float(traj_dict.get("speed", 150.0))
        loops = int(traj_dict.get("loops", 0))
        # clamp to workspace
        straight = min(abs(straight), (X_MAX - X_MIN) - 2.0*r - 20.0)
        r = min(abs(r), (Y_MAX - Y_MIN)/2.0 - 10.0)
        return Racetrack((cx, cy), straight=straight, radius=r, speed=speed, loops=loops)

    if ttype == "clothoid":
        k_rate = float(traj_dict.get("k_rate", 1e-5)) if "k_rate" in traj_dict else 1e-5
        speed = float(traj_dict.get("speed", 120.0))
        duration = float(traj_dict.get("duration", 30.0))
        return Clothoid(k_rate=k_rate, speed=speed, duration=duration)

    if ttype == "spiral":
        r0 = float(traj_dict.get("r0", 20.0)) if "r0" in traj_dict else 20.0
        k = float(traj_dict.get("k", 10.0)) if "k" in traj_dict else 10.0
        period = float(traj_dict.get("period", 30.0))
        duration = float(traj_dict.get("duration", 30.0))
        return Spiral((cx, cy), r0=r0, k=k, period=period, duration=duration)

    if ttype in ("spline", "astar", "rrtstar", "mpc"):
        # For now: interpret as waypoint path (real A*/RRT*/MPC would need map/obstacles).
        wps = traj_dict.get("waypoints")
        if not isinstance(wps, list) or len(wps) < 2:
            # If end exists, use start->end; else just hold
            end = _safe_get_xy(traj_dict.get("end"), start_xy)
            end = clamp_xy(*end)
            wps = [{"x": start_xy[0], "y": start_xy[1]}, {"x": end[0], "y": end[1]}]
        wp_xy = [clamp_xy(float(p["x"]), float(p["y"])) for p in wps]
        duration = float(traj_dict.get("duration", 30.0))
        return SplinePath(wp_xy, duration=duration)

    # Fallback: hold
    return Hold(start_xy)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="test.mosquitto.org")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--cmd_topic", default="huber/robot/plan/cmd")
    ap.add_argument("--goal_topic", default="huber/robot/goal")
    ap.add_argument("--status_topic", default="huber/robot/plan/status")
    ap.add_argument("--qos", type=int, default=0, choices=[0, 1, 2])
    ap.add_argument("--retain", action="store_true", help="Retener el último goal (cada publish sobreescribe el retained)")
    ap.add_argument("--dt", type=float, default=0.1, help="segundos entre goals publicados (0.1 recomendado)")
    ap.add_argument("--y_positive", choices=["up", "down"], default="up", help="convención al PUBLICAR al robot")
    ap.add_argument("--client_id", default=f"planner_{int(time.time())}")
    args = ap.parse_args()

    state = PlannerState(x=0.0, y=0.0, seq=0, mode="hold", paused=False, traj=Hold((0.0, 0.0)), traj_started_ms=now_ms())
    lock = threading.Lock()
    pending_cmd: Dict[str, Any] = {"has": False, "msg": None}

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=args.client_id, clean_session=True)

    connected = {"ok": False}

    def on_connect(cl, userdata, flags, reason_code, properties):
        connected["ok"] = (reason_code == 0)
        if connected["ok"]:
            print(f"[MQTT] Conectado a {args.host}:{args.port}")
            cl.subscribe(args.cmd_topic, qos=args.qos)
            print(f"[SUB ] cmd_topic='{args.cmd_topic}' qos={args.qos}")
        else:
            print(f"[MQTT] Error connect reason_code={reason_code}")

    def on_disconnect(cl, userdata, reason_code, properties):
        connected["ok"] = False
        print(f"[MQTT] Desconectado reason_code={reason_code}")

    def on_message(cl, userdata, msg):
        try:
            payload = msg.payload.decode("utf-8", errors="replace").strip()
            obj = json.loads(payload)
        except Exception as e:
            print(f"[CMD ] payload inválido: {e}")
            return

        with lock:
            pending_cmd["has"] = True
            pending_cmd["msg"] = obj

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    client.connect(args.host, args.port, keepalive=30)
    client.loop_start()

    # Espera conexión
    t0_wait = time.monotonic()
    while not connected["ok"] and (time.monotonic() - t0_wait) < 5.0:
        time.sleep(0.05)
    if not connected["ok"]:
        raise SystemExit("No se pudo conectar al broker en 5s.")

    def publish_status(ok: bool, note: str, cmd: Optional[dict] = None):
        st = {
            "ok": bool(ok),
            "note": note,
            "t_ms": now_ms(),
            "mode": state.mode,
            "paused": state.paused,
            "x": round(state.x, 2),
            "y": round(state.y, 2),
        }
        if cmd is not None:
            st["cmd"] = cmd
        try:
            client.publish(args.status_topic, payload=json.dumps(st, ensure_ascii=False), qos=args.qos, retain=False)
        except Exception:
            pass

    def apply_cmd(obj: dict):
        nonlocal state
        # Expected: {"cmd": {...}, "t_ms": ...}
        cmd = obj.get("cmd") if isinstance(obj, dict) else None
        if not isinstance(cmd, dict):
            publish_status(False, "cmd missing or not dict", obj if isinstance(obj, dict) else None)
            return

        intent = (cmd.get("intent") or "").lower().strip()
        start_xy = (state.x, state.y)

        if intent == "noop" or intent == "":
            publish_status(True, "noop", cmd)
            return

        if intent == "pause":
            state.paused = True
            publish_status(True, "paused", cmd)
            return

        if intent == "resume":
            state.paused = False
            # restart t0 so trajectory doesn't jump in time
            if state.traj is not None:
                state.traj.reset((state.x, state.y), time.monotonic())
                state.traj_started_ms = now_ms()
            publish_status(True, "resumed", cmd)
            return

        if intent == "stop":
            state.mode = "stop"
            state.traj = Hold((state.x, state.y))
            state.traj.reset((state.x, state.y), time.monotonic())
            state.traj_started_ms = now_ms()
            publish_status(True, "stopped (holding current)", cmd)
            return

        if intent in ("goto", "delta"):
            if intent == "goto":
                x = float(cmd.get("x", state.x))
                y = float(cmd.get("y", state.y))
            else:
                dx = float(cmd.get("dx", 0.0))
                dy = float(cmd.get("dy", 0.0))
                x = state.x + dx
                y = state.y + dy

            x, y = clamp_xy(x, y)
            # model goto as LineTo for smoothness
            speed = 150.0
            traj = LineTo((x, y), speed=speed)
            traj.reset(start_xy, time.monotonic())
            state.mode = "traj"
            state.traj = traj
            state.traj_started_ms = now_ms()
            publish_status(True, f"goto/delta -> LineTo(speed={speed})", cmd)
            return

        if intent == "traj":
            traj_dict = cmd.get("traj")
            if not isinstance(traj_dict, dict):
                publish_status(False, "traj missing or not dict", cmd)
                return
            try:
                traj = _mk_traj(traj_dict, start_xy)
                traj.reset(start_xy, time.monotonic())
                state.mode = "traj"
                state.traj = traj
                state.traj_started_ms = now_ms()
                publish_status(True, f"traj set: {traj_dict.get('type')}", cmd)
            except Exception as e:
                publish_status(False, f"traj error: {e}", cmd)
            return

        publish_status(False, f"unknown intent: {intent}", cmd)

    # Loop publishing goals at dt
    dt = max(0.01, float(args.dt))
    next_tick = time.monotonic()
    if args.retain:
        print(f"[PUB ] goal_topic='{args.goal_topic}' qos={args.qos} retain=True dt={dt:.3f}s")
    else:
        print(f"[PUB ] goal_topic='{args.goal_topic}' qos={args.qos} retain=False dt={dt:.3f}s")
    print(f"[STAT] status_topic='{args.status_topic}'")

    try:
        while True:
            # Apply pending cmd
            obj = None
            with lock:
                if pending_cmd["has"]:
                    obj = pending_cmd["msg"]
                    pending_cmd["has"] = False
                    pending_cmd["msg"] = None
            if obj is not None:
                apply_cmd(obj)

            now = time.monotonic()
            if now < next_tick:
                time.sleep(next_tick - now)
                continue

            next_tick += dt

            with lock:
                if state.paused:
                    # still publish hold (optional); here we publish current
                    x, y = state.x, state.y
                else:
                    traj = state.traj or Hold((state.x, state.y))
                    t = max(0.0, now - traj.t0)
                    x, y, done = traj.sample(t)
                    x, y = clamp_xy(x, y)
                    state.x, state.y = x, y
                    if done:
                        # after finishing, hold last point
                        state.mode = "hold"
                        state.traj = Hold((x, y))
                        state.traj.reset((x, y), now)
                        state.traj_started_ms = now_ms()

                payload = build_goal_payload(state.x, state.y, state.seq, args.y_positive)
                state.seq += 1

            client.publish(args.goal_topic, payload=payload, qos=args.qos, retain=args.retain)

    except KeyboardInterrupt:
        print("\n[CTRL+C] Saliendo...")
    finally:
        client.loop_stop()
        try:
            client.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    main()
