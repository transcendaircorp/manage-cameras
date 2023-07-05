//@ts-check

import { spawn, exec, ChildProcess } from 'child_process'
import express from 'express'

/**
 * Runs command to fetch currently attached cameras.
 * @returns {Promise<number[]>}
 */
function getCameras(){
  return new Promise((resolve, reject) => {
    exec('v4l2-ctl --list-devices', (err, stdout, stderr) => {
      if (err)
        reject(err)
      let lines = stdout.split('\n')
      let cameras = []
      for(let i = 1; i < lines.length; i++)
        if (lines[i-1].endsWith(':'))
          cameras.push(lines[i].split('video')[1].trim())
      resolve(cameras.map(Number))
    })
  })
}

/**
 * Returns a list of storage devices
 * @returns {Promise<object[]>}
 */
function getStorageStats(){
  return new Promise((resolve, reject) => {
    exec('df', (err, stdout, stderr) => {
      if (err)
        reject(err)
      resolve(stdout.split('\n').flatMap(l => {
        if (l.startsWith('/dev')){
          let parts = l.trim().split(/\s+/)
          return [{
            device: parts[0],
            size: parts[1],
            used: parts[2],
            available: parts[3],
            use: parts[4],
            mount: parts[5]
          }]
        } else 
          return []
      }))
    })
  })
}


/** @typedef {{name:string, size: number, date: Date}} videoFile */
/**
 * Returns a list of all files in the Videos directory
 * @returns {Promise<videoFile[]>}
 */
function getVideos(){
  return new Promise((resolve, reject) => {
    exec('ls -l --full-time /media/videousb', (err, stdout, stderr) => {
      if (err)
        reject(err)
      resolve(stdout.split('\n').slice(1, -1).map(l => {
        const parts = l.trim().split(/\s+/)
        /** @type {videoFile} */
        const file = {
          name: parts[8],
          size: Number(parts[4]),
          date: new Date(parts.slice(5, 7).join(' '))
        }
        return file
      }))
    })
  })
}



/**
 * Kill specified process, and wait for it to exit.
 * @param {ChildProcess} process Process to kill
 * @param {NodeJS.Signals} signal Signal to send to process
 * @returns {Promise<void>}
 */
function killProcess(process, signal = 'SIGINT'){
  return new Promise((resolve, reject) => {
    if(process.exitCode != null) return resolve()
    process.on('exit', () => resolve())
    process.on('error', err => reject(err))
    process.kill(signal)
  })
}

/**
 * Kills all processes, waits for them to exit, then cleans up process list.
 * @param {Object.<number, ChildProcess>} processes Map of processes to kill
 * @param {NodeJS.Signals | undefined} signal Signal to send to process
 * @returns {Promise<void>}
 */
async function killProcesses(processes, signal = undefined){
  await Promise.all(Object.values(processes).map(process =>
    killProcess(process, signal)
    .then(()=> delete processes[process.pid])))
}

/**
 * Start camera process
 * @param {number} camera Video stream number
 * @param {number} port Port to listen on
 * @returns {ChildProcess}
 */

// ("c,camera", "Path to camera device, i.e. /dev/video0", cxxopts::value<std::string>()) //
//       ("f,framerate", "Framerate for the video source", cxxopts::value<int>())                                //
//       ("r,resolution", "Resolution for the video source, i.e. 1920x1080", cxxopts::value<std::string>())      //
//       ("h,help", "");
function startCamera(camera, port){
  let args = [
    '-c',
    `/dev/video${camera}`,
    '-f',
    '60',
    '-r',
    '1920x1080',
    '-a',
    '239.200.10.37:' + port
  ]
  return spawn('cam2rtpfile', args)
}

/**
 * Function which formats date to be used in file names
 * @param {Date} date 
 * @returns {string}
 */
function formatDate(date){
  return `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`
}

/**
 * Start all the cameras. If a session is passed in, the cameras will record to a file.
 * @returns {Promise<ChildProcess[]>}
 */
async function startCameras(){
  const cameras = await getCameras()
  const port = 5000;
  return cameras.map((camera, i) => startCamera(camera, port+i))
}

/**
 * Write a string to processes stdin
 * @param {ChildProcess} process
 * @param {string} str
 * @returns {Promise<void>}
 */
function writeLn(process, str){
  return new Promise((res, rej) => {
    if(!process.stdin)
      rej('Process has no stdin')
    process.stdin.write(`${str}\n`, (err) => {
      if (err)
        rej(err)
      else
        res()
    })
  })
}

/** @type {Object.<number, ChildProcess>} */
const processes = {};
/** @type {Object.<number, string>} */
const cameraNames = {};

// Start cameras
(await startCameras()).forEach(p => processes[p.pid??-1] = p)
//basic express server
const app = express()
app.get('/record', async (req, res) => {
  let session = req.query.session
  if(!session) return res.sendStatus(400)
  Object.values(processes).forEach((p, i) => {
    const name = cameraNames[p.pid]??i;
    writeLn(p, `record /media/videousb/${session}_Video${name}--${formatDate(new Date())}`)
  })
  res.send('OK')
})
app.get('/stoprecord', async (req, res) => {
  Object.values(processes).forEach(p => {
    writeLn(p, 'stoprecord')
  })
  res.send('OK')
})
app.get('/play', async (req, res)=> {
  Object.values(processes).forEach(p => {
    writeLn(p, 'play')
  })
  res.send('OK')
})
app.get('/pause', async (req, res)=> {
  Object.values(processes).forEach(p => {
    writeLn(p, 'pause')
  })
  res.send('OK')
})
app.get('/stop', async (req, res)=> {
  Object.values(processes).forEach(p => {
    writeLn(p, 'stop')
  })
  res.send('OK')
})
app.get('/restart', async (req, res) => {
  await killProcesses(processes)
  try {
    (await startCameras()).forEach(p => processes[p.pid??-1] = p)
  } catch(err){
    res.sendStatus(500)
    return
  }
  res.status(200)
  res.send('OK')
})
app.get('/status', async (req, res) => {
  res.header('Content-Type', 'application/json')
  res.send(JSON.stringify({
    processes: Object.values(processes).map(p => ({
      args: p.spawnargs,
      exitCode: p.exitCode,
      pid: Number(p.pid),
    })),
    freeStorage: await getStorageStats(),
    videoFiles: await getVideos()
  }))
})
app.get('/setCameraNames', async (req, res) => {
  Object.assign(cameraNames, req.query)
  res.send('OK')
})
//serve express
app.listen(8080, () => {
  console.log('listening on port 8080')
})

/** @type {Array<NodeJS.Signals>} */
const sigs = ['SIGTERM', 'SIGINT'];
for(const sig of sigs)
  process.on(sig, async () => {
    await killProcesses(processes, sig)
    process.exit(0)
  })
