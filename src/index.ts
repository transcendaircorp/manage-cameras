import { spawn, exec, type ChildProcess } from "child_process";
import express from "express";

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
  deviceNumber: number;
  formats: VideoFormat[];
}

function parseVideoFormats(output: string): VideoFormat[] {
  const formats: VideoFormat[] = [];
  const lines = output.split("\n");

  let currentPixelFormat: string | null = null;
  let currentSize: { width: number; height: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].trim().split(":");
    if (parts.length !== 2) continue;
    const key = parts[0].trim();
    const value = parts[1].trim();

    if (key === "Pixel Format") {
      currentPixelFormat = null;
      const pixelFormatMatch = value.match(/'(.*)'/);
      if (pixelFormatMatch === null) continue;
      currentPixelFormat = pixelFormatMatch[1];
      continue;
    }
    if (key === "Size") {
      currentSize = null;
      const sizeMatch = value.match(/(\d+)x(\d+)/);
      if (sizeMatch === null) continue;
      currentSize = {
        width: parseInt(sizeMatch[1]),
        height: parseInt(sizeMatch[2]),
      };
      continue;
    }
    if (key === "Interval") {
      const intervalMatch = value.match(/.*(\d+\.\d+)s \((\d+\.\d+) fps\)/);
      if (intervalMatch === null) continue;
      formats.push({
        pixelFormat: currentPixelFormat ?? "",
        width: currentSize?.width ?? 0,
        height: currentSize?.height ?? 0,
        fps: parseFloat(intervalMatch[2]),
      });
    }
  }
  return formats;
}

async function execAsync(command: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    exec(command, (err, stdout, _stderr) => {
      if (err != null) reject(err);
      resolve(stdout);
    });
  });
}
/**
 * Runs command to fetch currently attached cameras.
 */
async function getCameras(): Promise<CameraProperties[]> {
  const lines = (await execAsync("v4l2-ctl --list-devices")).split("\n");
  const cameras: number[] = [];
  for (let i = 1; i < lines.length; i++)
    if (lines[i - 1].endsWith(":"))
      cameras.push(Number(lines[i].split("video")[1].trim()));
  return await Promise.all(
    cameras.map(async (c) => {
      const res = await execAsync(`v4l2-ctl -d ${c} --list-formats-ext`);
      return {
        deviceNumber: c,
        formats: parseVideoFormats(res),
      };
    })
  );
}

/**
 * Returns a list of storage devices
 */
async function getStorageStats(): Promise<StorageDevice[]> {
  return await new Promise((resolve, reject) => {
    exec("df", (err, stdout, _stderr) => {
      if (err != null) reject(err);
      resolve(
        stdout.split("\n").flatMap((l) => {
          if (l.startsWith("/dev")) {
            const parts = l.trim().split(/\s+/);
            return [
              {
                device: parts[0],
                size: Number(parts[1]),
                used: Number(parts[2]),
                available: Number(parts[3]),
                use: parts[4],
                mount: parts[5],
              },
            ];
          } else return [];
        })
      );
    });
  });
}

/**
 * Returns a list of all files in the Videos directory
 */
async function getVideos(): Promise<VideoFile[]> {
  return await new Promise((resolve, reject) => {
    exec("ls -l --full-time /media/videousb", (err, stdout, _stderr) => {
      if (err != null) reject(err);
      resolve(
        stdout
          .split("\n")
          .slice(1, -1)
          .map((l) => {
            const parts = l.trim().split(/\s+/);
            return {
              name: parts[8],
              size: Number(parts[4]),
              date: new Date(parts.slice(5, 7).join(" ")),
            };
          })
      );
    });
  });
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
function startCamera(camera: CameraProperties, port: number): CameraProcess {
  // find best format
  const format = camera.formats
    .filter((c) => c.pixelFormat.toLocaleUpperCase() === "MJPG")
    .filter((c) => c.width === 1920 && c.height === 1080)
    .reduce((a, b) => (a.fps > b.fps ? a : b));
  return {
    port,
    proc: spawn("cam2rtpfile", [
      "-c",
      `/dev/video${camera.deviceNumber}`,
      "-f",
      format.fps.toString(),
      "-r",
      `${format.width}x${format.height}`,
    ]),
  };
}

/**
 * Formats date to be used in file names
 */
function formatDate(date: Date): string {
  return `${date.getFullYear()}-${
    date.getMonth() + 1
  }-${date.getDate()}-${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`;
}

/**
 * Start all the cameras. If a session is passed in, the cameras will record to a file.
 */
async function startCameras(): Promise<void> {
  const port = 5000;
  const cameras = await getCameras();
  for (const [i, cameraProperties] of cameras.entries()) {
    const camera = startCamera(cameraProperties, port + i);
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
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/record", async (req, res) => {
  const sessionValue = req.query.session;
  if (sessionValue == null || !(sessionValue instanceof String))
    return res.sendStatus(400);
  const session = sessionValue as string;
  for (const [i, p] of [...cameraProcesses.values()].entries()) {
    const name = p.proc.pid == null ? i : cameraNames.get(p.proc.pid) ?? i;
    await writeLn(
      p.proc,
      `record /media/videousb/${session}_Video${name}--${formatDate(
        new Date()
      )}`
    );
  }
  res.send("OK");
});
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/:command(stoprecord|play|pause|stop)", async (req, res) => {
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
  res.send(
    JSON.stringify({
      processes: [...cameraProcesses.values()].map((p) => ({
        args: p.proc.spawnargs,
        exitCode: p.proc.exitCode,
        signalCode: p.proc.signalCode,
        pid: p.proc.pid,
      })),
      freeStorage: await getStorageStats(),
      videoFiles: await getVideos(),
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
