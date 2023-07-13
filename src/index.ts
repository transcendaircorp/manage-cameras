import { spawn, exec, type ChildProcess } from "child_process";
import { promisify } from 'util';
import express from "express";
import parseGstDevices from "./parse.js"
import nodeDiskInfo from 'node-disk-info';
import { type Dir } from "fs";
import { readdir, opendir, stat, rm } from "fs/promises"
import { join } from "path";
import fastFolderSize from "fast-folder-size"
const folderSize = promisify(fastFolderSize)
const execAsync = promisify(exec);

interface StorageDevice {
  device: string;
  size: number;
  used: number;
  available: number;
  use: string;
  mount: string;
}
interface VideoFile {
  name: string;
  size: number;
  date: Date;
}
interface CameraProcess {
  port: number;
  proc: ChildProcess;
}
interface VideoFormat {
  pixelFormat: string;
  width: number;
  height: number;
  fps: number;
}
interface CameraProperties {
  path: string;
  formats: VideoFormat[];
}

if (process.env.VIDEO_DIR === undefined) {
  console.error("Please run the program with a VIDEO_DIR env variable")
  process.exit(1);
}
const videoDir = process.env.VIDEO_DIR;
let dir: Dir;
try {
  dir = await opendir(videoDir)
} catch (err) {
  console.error("VIDEO_DIR not valid, please make sure directory exists")
  process.exit(1);
}
await dir.close();

/**
 * Runs command to fetch currently attached cameras.
 */
async function getCameras(): Promise<CameraProperties[]> {
  const output = await execAsync("gst-device-monitor-1.0 Video/Source:image/jpeg,width=1920,height=1080");
  const devices = parseGstDevices(output.stdout);

  return devices.map(d => {
    if (d.properties?.device?.path == null) return undefined;
    const formats = d.caps?.map(c => {
      let width: number = Number.NaN;
      if (c.parameters.width?.type === "atom") {
        width = + c.parameters.width.value;
      }
      if (isNaN(width))
        return undefined;
      let height: number = Number.NaN;
      if (c.parameters.height?.type === "atom") {
        height = + c.parameters.height.value;
      }
      if (isNaN(height))
        return undefined;
      let fps: number = Number.NaN;
      if (c.parameters.framerate?.type === "atom") {
        const s = c.parameters.framerate.value.split("/")
        if (s.length !== 2) return undefined;
        fps = +s[0] / +s[1]
      } else if (c.parameters.fps.type === "range") {
        fps = +c.parameters.fps.max / +(c.parameters.fps.maxdenom ?? "")
      }
      if (isNaN(fps)) return undefined;
      if (c.type === undefined) return undefined
      return {
        width,
        height,
        fps,
        pixelFormat: c.type
      }
    }).filter((x): x is VideoFormat => !(x == null))
    if ((formats == null) || formats.length === 0)
      return undefined;
    return {
      path: d.properties?.device?.path,
      formats
    }
  }).filter((x): x is CameraProperties => !(x == null));
}

/**
 * Returns a list of storage devices
 */
async function getStorageStats(): Promise<StorageDevice[] | null> {
  try {
    const drives = nodeDiskInfo.getDiskInfoSync();
    return drives.map(d => ({
      device: d.filesystem,
      size: d.blocks,
      used: d.used,
      available: d.available,
      use: d.capacity,
      mount: d.mounted,
    }));
  } catch (e) {
    console.error(e);
    return null
  }
}

/**
 * Returns a list of all files in the Videos directory
 */
async function getVideos(): Promise<VideoFile[]> {
  const files = await readdir(videoDir);
  const data: VideoFile[] = []
  for (const file of files) {
    const stats = await stat(join(videoDir, file));
    data.push({
      name: file,
      size: stats.size,
      date: stats.ctime
    })
  }
  return data;
}

/**
 * Kill specified process, and wait for it to exit.
 * @param process Process to kill
 * @param signal Signal to send to process
 */
async function killProcess(
  process: ChildProcess,
  signal: NodeJS.Signals = "SIGINT"
): Promise<void> {
  let exitCb: () => void;
  await new Promise<void>((resolve, reject) => {
    exitCb = resolve;
    if (process.exitCode != null || process.signalCode != null) {
      exitCb();
      return;
    }
    process.on("exit", exitCb);
    process.on("error", exitCb);
    process.on("close", exitCb);
    process.on("disconnect", exitCb);
    setTimeout(reject, 2000);
    process.kill(signal);
  }).finally(() => {
    process.off("exit", exitCb);
    process.off("error", exitCb);
    process.off("close", exitCb);
    process.off("disconnect", exitCb);
  });
}

/**
 * Kills all processes, waits for them to exit, then cleans up process list.
 * @param processes Map of processes to kill
 * @param signal Signal to send to processes
 */
async function killProcesses(
  processes: CameraProcessMap,
  signal: NodeJS.Signals | undefined = undefined
): Promise<Array<PromiseSettledResult<void>>> {
  return await Promise.allSettled(
    [...processes.values()].flatMap((process) => {
      if (process.proc.killed || process.proc.signalCode != null) {
        processes.delete(process.proc.pid ?? -1);
        return [];
      }
      return [
        killProcess(process.proc, signal)
          .catch()
          .finally(() => processes.delete(process.proc.pid ?? -1)),
      ];
    })
  );
}

/**
 * Start camera process
 * @param camera Video stream number
 * @param port Port to listen on
 */
function startCamera(camera: CameraProperties, port: number): CameraProcess | null {
  // find best format
  const formats = camera.formats
    .filter((c) => c.pixelFormat.toLocaleLowerCase() === "image/jpeg")
    .filter((c) => c.width === 1920 && c.height === 1080)
  if (formats.length === 0)
    return null;
  const format = formats.reduce((a, b) => (a.fps > b.fps ? a : b));
  return {
    port,
    proc: spawn("cam2rtpfile", [
      "-c",
      camera.path,
      "-f",
      format.fps.toString(),
      "-r",
      `${format.width}x${format.height}`,
    ]),
  };
}
const zeroPad = (num: number, places: number): string => String(num).padStart(places, '0')
/**
 * Formats date to be used in file names
 */
function formatDate(date: Date): string {
  return `${zeroPad(date.getFullYear(), 4)}-${zeroPad((date.getMonth() + 1), 2)
    }-${zeroPad(date.getDate(), 2)}-${zeroPad(date.getHours(), 2)}-${zeroPad(date.getMinutes(), 2)}-${zeroPad(date.getSeconds(), 2)}`;
}

/**
 * Start all the cameras. If a session is passed in, the cameras will record to a file.
 */
async function startCameras(): Promise<void> {
  const port = 5000;
  const cameras = await getCameras();
  for (const [i, cameraProperties] of cameras.entries()) {
    const camera = startCamera(cameraProperties, port + i);
    if (camera === null) continue;
    const process = camera.proc;
    const pid = process.pid as number;
    process.on("disconnect", () => {
      console.log("Camera disconnected: ", pid);
      cameraProcesses.delete(pid);
    });
    process.on("exit", (code, signal) => {
      console.log("Camera exit: ", pid, code, signal);
      cameraProcesses.delete(pid);
    });
    process.on("close", (code, signal) => {
      console.log("Camera close: ", pid, code, signal);
      cameraProcesses.delete(pid);
    });
    process.on("error", (err) => {
      console.log("Camera error: ", pid, err);
      cameraProcesses.delete(pid);
    });
    process.stderr?.on("data", (data) => {
      console.error(`cam2rtpfile [${pid}]: `, data.toString().trim())
    })
    process.stdout?.on("data", (data) => {
      console.log(`cam2rtpfile [${pid}]: `, data.toString().trim())
    })
    cameraProcesses.set(pid, camera);
  }
}

/**
 * Write a string to processes stdin
 */
async function writeLn(process: ChildProcess, str: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (process.stdin == null || !process.stdin.writable) {
      reject(new Error("Cannot write to process stdin"));
      return;
    }
    try {
      process.stdin.write(`${str}\n`, (err) => {
        if (err != null) reject(err);
        else resolve();
      });
    } catch (e) {
      reject(new Error("Cannot write to process stdin"));
    }
  });
}

type CameraProcessMap = Map<number, CameraProcess>;
const cameraProcesses: CameraProcessMap = new Map();
type CameraNameMap = Map<number, string>;
const cameraNames: CameraNameMap = new Map();

function logError(msg: string) {
  return (err: Error) => {
    console.error(msg, err);
  };
}

await startCameras();
// basic express server
const app = express();
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/request", async (req, res) => {
  const ip = req.ip.split(":").slice(-1)[0];
  for (const p of cameraProcesses.values()) {
    try {
      await writeLn(p.proc, `addclient ${ip} ${p.port}`);
    } catch (e) {
      logError(`Failed to add client ${ip} to camera ${p.port}`);
    }
  }
  res.send("OK");
});
const currentRecordFiles: string[] = []
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/record", async (req, res) => {
  const session = req.query.session as string;
  if (session == null) return res.sendStatus(400);
  currentRecordFiles.length = 0
  for (const [i, p] of [...cameraProcesses.values()].entries()) {
    const name = p.proc.pid == null ? i : cameraNames.get(p.proc.pid) ?? i;
    const file = `${session}_Video${name}--${formatDate(new Date())}`
    await writeLn(
      p.proc,
      `record "${join(videoDir, file).replaceAll('\\', '\\\\')}"`
    );
    currentRecordFiles.push(file)
  }
  res.send("OK");
});
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/stoprecord", async (req, res) => {
  for (const p of cameraProcesses.values())
    await writeLn(p.proc, "stoprecord");
  if (req.query.deleteFiles != null)
    for (const file of currentRecordFiles)
      for (const matchingFile of (await readdir(videoDir)).filter(f => f.startsWith(file)))
        await rm(join(videoDir, matchingFile))
  currentRecordFiles.length = 0
  res.send("OK");
});
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/:command(play|pause|stop)", async (req, res) => {
  for (const p of cameraProcesses.values())
    await writeLn(p.proc, req.params.command);
  res.send("OK");
});
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/restart", async (_req, res) => {
  const failed = (await killProcesses(cameraProcesses)).filter(
    (k) => k.status === "rejected"
  );
  if (failed.length > 0) {
    res.status(500);
    res.send(failed.map((f) => f));
    return;
  }
  try {
    await startCameras();
  } catch (err) {
    res.sendStatus(500);
    return;
  }
  res.status(200);
  res.send("OK");
});
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/status", async (_req, res) => {
  res.header("Content-Type", "application/json");
  const freeStorage = await getStorageStats();
  const videoFiles = await getVideos();
  const size = await folderSize(videoDir);
  res.send(
    JSON.stringify({
      processes: [...cameraProcesses.values()].map((p) => ({
        args: p.proc.spawnargs,
        exitCode: p.proc.exitCode,
        signalCode: p.proc.signalCode,
        pid: p.proc.pid,
      })),
      freeStorage,
      videoFiles,
      folderSize: size
    })
  );
});
app.get("/setCameraNames", (req, res) => {
  Object.assign(cameraNames, req.query);
  res.send("OK");
});
// serve express
app.listen(8080, () => {
  console.log("listening on port 8080");
});

const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGQUIT"];
for (const sig of sigs) {
  process.on(sig, () => {
    killProcesses(cameraProcesses, sig)
      .then(() => process.exit(0))
      .catch(() => {
        killProcesses(cameraProcesses, "SIGKILL").finally(() => {
          process.exit(1);
        });
      });
  });
}
