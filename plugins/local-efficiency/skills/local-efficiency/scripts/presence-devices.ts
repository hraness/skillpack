/**
 * Microphone and camera "running somewhere" flags, read in a worker thread.
 *
 * CoreAudio and CoreMediaIO answer in under a millisecond once warm, but the
 * first call loads device plug-ins and has taken seconds on a loaded Mac.
 * Running them here keeps host-run's own thread free to forward signals, and
 * lets the caller give up after a deadline.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

declare const self: Worker;

export type DeviceState = { readonly camera: boolean; readonly microphone: boolean };

const fourcc = (value: string): number =>
  ((value.charCodeAt(0) << 24) | (value.charCodeAt(1) << 16) | (value.charCodeAt(2) << 8) | value.charCodeAt(3)) >>> 0;

const propertySize = { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } as const;

function openDevices() {
  const audio = dlopen("/System/Library/Frameworks/CoreAudio.framework/CoreAudio", {
    AudioObjectGetPropertyData: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    AudioObjectGetPropertyDataSize: propertySize,
  });
  const media = dlopen("/System/Library/Frameworks/CoreMediaIO.framework/CoreMediaIO", {
    CMIOObjectGetPropertyData: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CMIOObjectGetPropertyDataSize: propertySize,
  });
  return { audio, media };
}

type Devices = ReturnType<typeof openDevices>;

const devicesAddress = (): Uint32Array => new Uint32Array([fourcc("dev#"), fourcc("glob"), 0]);
const runningAddress = (): Uint32Array => new Uint32Array([fourcc("gone"), fourcc("glob"), 0]);

function microphoneInUse(devices: Devices): boolean {
  const s = devices.audio.symbols;
  const size = new Uint32Array(1);
  if (s.AudioObjectGetPropertyDataSize(1, ptr(devicesAddress()), 0, null, ptr(size)) !== 0 || size[0] === 0) return false;
  const ids = new Uint32Array(size[0]! / 4);
  if (s.AudioObjectGetPropertyData(1, ptr(devicesAddress()), 0, null, ptr(size), ptr(ids)) !== 0) return false;
  for (const id of ids.subarray(0, size[0]! / 4)) {
    const streams = new Uint32Array(1);
    s.AudioObjectGetPropertyDataSize(id, ptr(new Uint32Array([fourcc("stm#"), fourcc("inpt"), 0])), 0, null, ptr(streams));
    if (streams[0] === 0) continue;
    const running = new Uint32Array(1);
    const length = new Uint32Array([4]);
    if (s.AudioObjectGetPropertyData(id, ptr(runningAddress()), 0, null, ptr(length), ptr(running)) === 0 && running[0] !== 0) {
      return true;
    }
  }
  return false;
}

function cameraInUse(devices: Devices): boolean {
  const s = devices.media.symbols;
  const size = new Uint32Array(1);
  if (s.CMIOObjectGetPropertyDataSize(1, ptr(devicesAddress()), 0, null, ptr(size)) !== 0 || size[0] === 0) return false;
  const ids = new Uint32Array(size[0]! / 4);
  const used = new Uint32Array(1);
  if (s.CMIOObjectGetPropertyData(1, ptr(devicesAddress()), 0, null, size[0]!, ptr(used), ptr(ids)) !== 0) return false;
  for (const id of ids.subarray(0, used[0]! / 4)) {
    const running = new Uint32Array(1);
    if (s.CMIOObjectGetPropertyData(id, ptr(runningAddress()), 0, null, 4, ptr(used), ptr(running)) === 0 && running[0] !== 0) {
      return true;
    }
  }
  return false;
}

let devices: Devices | undefined;

/** Reads both flags on the calling thread. */
export function readDevices(): DeviceState {
  devices ??= openDevices();
  return { camera: cameraInUse(devices), microphone: microphoneInUse(devices) };
}

if (!Bun.isMainThread) {
  self.onmessage = () => {
    try {
      self.postMessage({ ok: true, state: readDevices() });
    } catch (error: unknown) {
      self.postMessage({ error: error instanceof Error ? error.message : String(error), ok: false });
    }
  };
}
