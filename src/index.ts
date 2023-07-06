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

/**
 * Runs command to fetch currently attached cameras.
 */
async function getCameras(): Promise<number[]> {
  return await new Promise((resolve, reject) => {
    exec("v4l2-ctl --list-devices", (err, stdout, _stderr) => {
      if (err != null) reject(err);
      const lines = stdout.split("\n");
      const cameras = [];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i - 1].endsWith(":")) {
          cameras.push(lines[i].split("video")[1].trim());
        }
      }
      resolve(cameras.map(Number));
    });
  });
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
 * @param {ChildProcess} process Process to kill
 * @param {NodeJS.Signals} signal Signal to send to process
 * @returns {Promise<void>}
 */
async function killProcess(
  process: ChildProcess,
  signal: NodeJS.Signals = "SIGINT"
): Promise<void> {
  let exitCb: (code: number | null, signal: string | null) => void;
  let errorCb: (err: Error) => void;
  await new Promise<void>((resolve, reject) => {
    if (process.exitCode != null) {
      resolve();
      return;
    }
    exitCb = () => {
      resolve();
    };
    errorCb = (err) => {
      reject(err);
    };
    process.on("exit", exitCb);
    process.on("error", errorCb);
    process.on("close", exitCb);
    process.on("disconnect", exitCb);
    process.kill(signal);
    setTimeout(reject, 5000);
  }).finally(() => {
    process.off("exit", exitCb);
    process.off("error", errorCb);
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
function startCamera(camera: number, port: number): CameraProcess {
  const args = ["-c", `/dev/video${camera}`, "-f", "60", "-r", "1920x1080"];
  return {
    port,
    proc: spawn("cam2rtpfile", args),
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
async function startCameras(): Promise<CameraProcess[]> {
  const cameras = await getCameras();
  const port = 5000;
  return cameras.map((camera, i) => startCamera(camera, port + i));
}

/**
 * Write a string to processes stdin
 */
async function writeLn(process: ChildProcess, str: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (process.stdin == null) {
      reject(new Error("Process has no stdin"));
      return;
    }
    try {
      process.stdin.write(`${str}\n`, (err) => {
        if (err != null) reject(err);
        else resolve();
      });
    } catch (e) {
      console.log("Failed write\n");
    }
  });
}

type CameraProcessMap = Map<number, CameraProcess>;
const processes: CameraProcessMap = new Map();
type CameraNameMap = Map<number, string>;
const cameraNames: CameraNameMap = new Map();

// Start cameras
async function main(): Promise<void> {
  (await startCameras()).forEach((p) => processes.set(p.proc.pid ?? -1, p));
}

function logError(msg: string) {
  return (err: Error) => {
    console.error(err, msg);
  };
}

main().catch((err) => {
  console.error(err);
});
// basic express server
const app = express();
app.get("/request", (req, _res) => {
  // get ip of request
  const ip = req.ip.split(":").slice(-1)[0];
  for (const [, p] of processes) {
    writeLn(p.proc, `addclient ${ip} ${p.port}`).catch(
      logError(`Failed to add client ${ip} to camera ${p.port}`)
    );
  }
});
app.get("/record", (req, res) => {
  const sessionValue = req.query.session;
  // check if session is non null string
  if (sessionValue == null || !(sessionValue instanceof String)) {
    return res.sendStatus(400);
  }
  const session = sessionValue as string;
  let i = 0;
  for (const p of processes.values()) {
    const name = cameraNames.get(p.proc.pid ?? -1) ?? i;
    writeLn(
      p.proc,
      `record /media/videousb/${session}_Video${name}--${formatDate(
        new Date()
      )}`
    ).catch(logError(`Failed to start recording on camera ${p.port}`));
    i++;
  }
  res.send("OK");
});
app.get("/stoprecord", (_req, res) => {
  for (const p of processes.values()) {
    writeLn(p.proc, "stoprecord").catch(logError(""));
  }
  res.send("OK");
});
app.get("/play", (_req, res) => {
  for (const p of processes.values()) {
    writeLn(p.proc, "play").catch(logError(""));
  }
  res.send("OK");
});
app.get("/pause", (_req, res) => {
  for (const p of processes.values()) {
    writeLn(p.proc, "pause").catch(logError(""));
  }
  res.send("OK");
});
app.get("/stop", (_req, res) => {
  for (const p of processes.values()) {
    writeLn(p.proc, "stop").catch(logError(""));
  }
  res.send("OK");
});
// eslint-disable-next-line @typescript-eslint/no-misused-promises
app.get("/restart", async (_req, res) => {
  const failed = (await killProcesses(processes)).filter(
    (k) => k.status === "rejected"
  );
  if (failed.length > 0) {
    res.status(500);
    res.send(failed.map((f) => f));
    return;
  }
  try {
    (await startCameras()).forEach((p) => processes.set(p.proc.pid ?? -1, p));
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
      processes: Object.values(processes).map((p) => ({
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

const sigs: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
for (const sig of sigs) {
  process.on(sig, () => {
    killProcesses(processes, sig).finally(() => process.exit(0));
  });
}
