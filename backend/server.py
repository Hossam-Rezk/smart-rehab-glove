"""
Smart Rehabilitation Glove - local web server.

Start it with start.bat (or: python backend/server.py).
It opens http://localhost:8000 in the browser. There, press
"Connect glove" to connect to the Pico over USB.

The server:
  * talks to the Pico through the USB serial port (or a simulator),
  * runs the AI repetition-quality model on the live flex data,
  * runs the thumb-touch reaction test,
  * pushes everything live to the website over a WebSocket.
Patients, sessions and tutorials are stored in Supabase by the website.
"""
import asyncio
import os
import random
import sys
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ai import RepDetector, RepQualityModel  # noqa: E402
from glove import SIMULATOR_PORT, SerialGlove, SimulatedGlove, find_pico_port, list_glove_ports  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "web")
PORT = 8000

def quiet_exception_handler(loop, context):
    """Hide a harmless Windows asyncio error printed when a browser tab
    drops its connection (WinError 10054). Everything else is shown."""
    if isinstance(context.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
        return
    loop.default_exception_handler(context)


@asynccontextmanager
async def lifespan(_app):
    state.loop = asyncio.get_running_loop()
    state.loop.set_exception_handler(quiet_exception_handler)
    state.touch_down_event = asyncio.Event()
    state.touch_up_event = asyncio.Event()
    yield
    if state.glove:
        state.glove.close()


app = FastAPI(title="Smart Rehabilitation Glove", lifespan=lifespan)
model = RepQualityModel()


class State:
    def __init__(self):
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.glove = None
        self.device = None              # the "hello" message from the glove
        self.clients = set()            # one asyncio.Queue per open browser tab
        self.exercise = None            # None | "flex" | "thumb"
        self.target = 60
        self.detector = RepDetector()
        self.rep_count = 0
        self.last_sample = None
        self.touch = 0
        self.touch_down_event = asyncio.Event()
        self.touch_up_event = asyncio.Event()
        self.touch_down_at = 0.0
        self.touch_up_at = 0.0
        self.thumb_task = None
        self.lock = threading.Lock()


state = State()


# ------------------------------------------------------------
# Messages to the browser
# ------------------------------------------------------------
def broadcast(message):
    for queue in list(state.clients):
        if queue.qsize() < 500:
            queue.put_nowait(message)


def status_message():
    return {
        "type": "status",
        "connected": bool(state.glove and state.glove.is_open),
        "description": state.glove.description if state.glove else None,
        "device": state.device,
        "exercise": state.exercise,
        "target": state.target,
    }


# ------------------------------------------------------------
# Messages from the glove (called from the serial thread)
# ------------------------------------------------------------
def on_glove_message(message):
    if state.loop is not None:
        state.loop.call_soon_threadsafe(handle_glove_message, message)


def handle_glove_message(message):
    kind = message.get("type")
    if kind == "d":
        bend = int(message.get("b", 0))
        touch = int(message.get("k", 0))
        now = time.monotonic()
        if touch and not state.touch:
            state.touch_down_at = now
            state.touch_down_event.set()
        elif state.touch and not touch:
            state.touch_up_at = now
            state.touch_up_event.set()
        state.touch = touch
        state.last_sample = message
        broadcast({"type": "sample", "t": message.get("t"), "bend": bend, "touch": touch})

        if state.exercise == "flex":
            samples = state.detector.add(int(message.get("t", 0)), bend)
            if samples is not None:
                state.rep_count += 1
                result = model.analyse(samples, state.target)
                result.update(type="rep", rep_index=state.rep_count)
                broadcast(result)
    elif kind == "hello":
        state.device = message
        broadcast(status_message())
    elif kind == "disconnected":
        stop_exercise()
        if state.glove:
            state.glove.close()
        state.glove = None
        state.device = None
        broadcast({"type": "error", "message": message.get("reason", "Glove disconnected.")})
        broadcast(status_message())
    else:
        broadcast(message)          # calib, ack


def send_to_glove(command):
    if not (state.glove and state.glove.is_open):
        raise ConnectionError("The glove is not connected. Press \"Connect glove\" first.")
    state.glove.send(command)


def stop_exercise():
    state.exercise = None
    if state.thumb_task and not state.thumb_task.done():
        state.thumb_task.cancel()
    state.thumb_task = None
    if state.glove and state.glove.is_open:
        state.glove.send("MODE IDLE")


# ------------------------------------------------------------
# Thumb touch test
# ------------------------------------------------------------
async def wait_for(event, timeout):
    try:
        await asyncio.wait_for(event.wait(), timeout)
        return True
    except asyncio.TimeoutError:
        return False


async def run_thumb_test(trials):
    try:
        for trial in range(1, trials + 1):
            broadcast({"type": "thumb", "stage": "wait", "trial": trial, "trials": trials})
            if state.touch:                                # hand must be open first
                broadcast({"type": "thumb", "stage": "open_hand", "trial": trial})
                state.touch_up_event.clear()
                await wait_for(state.touch_up_event, 10)

            # random wait, so the patient cannot guess the moment
            for _ in range(4):
                state.touch_down_event.clear()
                touched_early = await wait_for(state.touch_down_event, random.uniform(1.5, 3.5))
                if not touched_early:
                    break
                broadcast({"type": "thumb", "stage": "early", "trial": trial})
                state.touch_up_event.clear()
                if state.touch:
                    await wait_for(state.touch_up_event, 10)

            state.touch_down_event.clear()
            state.touch_up_event.clear()
            send_to_glove("CUE")
            cue_at = time.monotonic()
            broadcast({"type": "thumb", "stage": "cue", "trial": trial})

            touched = await wait_for(state.touch_down_event, 3.0)
            if not touched:
                result = {"success": False, "reaction_ms": None, "hold_ms": None}
            else:
                reaction_ms = int((state.touch_down_at - cue_at) * 1000)
                released = await wait_for(state.touch_up_event, 5.0)
                end = state.touch_up_at if released else time.monotonic()
                result = {"success": True, "reaction_ms": max(reaction_ms, 0),
                          "hold_ms": int((end - state.touch_down_at) * 1000)}
            result.update(type="thumb", stage="result", trial=trial, trials=trials)
            broadcast(result)
            await asyncio.sleep(1.0)
        broadcast({"type": "thumb", "stage": "done"})
    except asyncio.CancelledError:
        pass
    except ConnectionError as error:
        broadcast({"type": "error", "message": str(error)})
    finally:
        if state.exercise == "thumb":
            state.exercise = None
            if state.glove and state.glove.is_open:
                state.glove.send("MODE IDLE")
            broadcast(status_message())


# ------------------------------------------------------------
# HTTP API used by the website
# ------------------------------------------------------------
class ConnectRequest(BaseModel):
    port: Optional[str] = None


class FlexRequest(BaseModel):
    target: int = 60


class ThumbRequest(BaseModel):
    trials: int = 10


def error(message, code=400):
    return JSONResponse({"ok": False, "error": message}, status_code=code)


@app.get("/api/status")
async def api_status():
    info = model.info
    status = status_message()
    status["model"] = {"name": info["model"], "accuracy": info["test_accuracy_unseen_people"],
                       "labels": info["labels"], "trained_at": info["trained_at"]}
    return status


@app.get("/api/ports")
async def api_ports():
    return {"ports": list_glove_ports(), "auto": find_pico_port()}


@app.post("/api/connect")
async def api_connect(request: ConnectRequest):
    if state.glove and state.glove.is_open:
        stop_exercise()
        state.glove.close()
    state.glove = None
    state.device = None
    port = request.port or find_pico_port()
    if not port:
        return error("No Pico found. Check the USB cable, close Thonny, and run setup_pico.bat once. "
                     "You can also choose \"Simulator\" to try the website without a glove.")
    glove = SimulatedGlove(on_glove_message) if port == SIMULATOR_PORT else SerialGlove(port, on_glove_message)
    try:
        await asyncio.to_thread(glove.connect)
    except ConnectionError as exc:
        return error(str(exc))
    state.glove = glove
    for _ in range(20):                        # wait up to 2 s for the glove to say hello
        if state.device:
            break
        await asyncio.sleep(0.1)
    if not state.device:
        glove.close()
        state.glove = None
        return error("Opened {} but the glove did not answer. Run setup_pico.bat to install the glove "
                     "program, then unplug and plug the USB cable back in.".format(port))
    broadcast(status_message())
    return {"ok": True, **status_message()}


@app.post("/api/disconnect")
async def api_disconnect():
    stop_exercise()
    if state.glove:
        state.glove.close()
    state.glove = None
    state.device = None
    broadcast(status_message())
    return {"ok": True}


@app.post("/api/calibrate")
async def api_calibrate():
    try:
        stop_exercise()
        send_to_glove("CALIBRATE")
    except ConnectionError as exc:
        return error(str(exc))
    return {"ok": True}


@app.post("/api/flex/start")
async def api_flex_start(request: FlexRequest):
    try:
        stop_exercise()
        state.target = max(10, min(100, request.target))
        send_to_glove("TARGET {}".format(state.target))
        send_to_glove("MODE FLEX")
    except ConnectionError as exc:
        return error(str(exc))
    state.detector.reset()
    state.rep_count = 0
    state.exercise = "flex"
    broadcast(status_message())
    return {"ok": True}


@app.post("/api/thumb/start")
async def api_thumb_start(request: ThumbRequest):
    try:
        stop_exercise()
        send_to_glove("MODE THUMB")
    except ConnectionError as exc:
        return error(str(exc))
    state.exercise = "thumb"
    state.thumb_task = asyncio.create_task(run_thumb_test(max(1, min(30, request.trials))))
    broadcast(status_message())
    return {"ok": True}


@app.post("/api/stop")
async def api_stop():
    stop_exercise()
    broadcast(status_message())
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    queue = asyncio.Queue()
    state.clients.add(queue)
    queue.put_nowait(status_message())
    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        state.clients.discard(queue)


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


def main():
    url = "http://localhost:{}".format(PORT)
    print("=" * 60)
    print(" Smart Rehabilitation Glove")
    print(" Website: " + url)
    print(" Keep this window open while using the website.")
    print(" Press Ctrl+C here to stop.")
    print("=" * 60)
    if "--no-browser" not in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
