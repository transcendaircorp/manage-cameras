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

/**
 * Kill specified process, and wait for it to exit.
 * @param {ChildProcess} process Process to kill
 * @param {NodeJS.Signals} signal Signal to send to process
 * @returns {Promise<void>}
 */
function killProcess(process, signal = 'SIGTERM'){
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
 * @param {string?} session Optional session name, which will be used to create a file to record to
 * @returns {ChildProcess}
 */
function startCamera(camera, port, session){
  let args = [
    '-i',
    `input_uvc.so -d /dev/video${camera} -r 1920x1080 -f 60`,
    '-o',
    `output_http.so -p ${port}`
  ]
  if (session)
    args.push('-o', `output_file.so -f /home/jetson/Videos -m ${session}_Video${camera}--${formatDate(new Date())}.mjpg`)
  return spawn('mjpg_streamer', args)
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
 * @param {string?} session 
 * @returns {Promise<ChildProcess[]>}
 */
async function startCameras(session){
  const cameras = await getCameras()
  const port = 8081;
  return cameras.map((camera, i) => startCamera(camera, port+i, session))
}

/** @type {Object.<number, ChildProcess>} */
const processes = {};

// Start cameras in streaming only mode
(await startCameras(null)).forEach(p => processes[p.pid??-1] = p)
//basic express server
const app = express()
app.get('/start', async (req, res) => {
  let session = req.query.session
  if(!session) return res.sendStatus(400)
  await killProcesses(processes)
  ;(await startCameras("" + session)).forEach(p => processes[p.pid??-1] = p)
  res.send('OK')
})
app.get('/stop', async (req, res) => {
  await killProcesses(processes)
  ;(await startCameras(null)).forEach(p => processes[p.pid??-1] = p)
  res.send('OK')
})
app.get('/status', async (req, res) => {
  res.send(JSON.stringify({
    processes: Object.values(processes).map(p => ({args: p.spawnargs, exitCode: p.exitCode, pid: p.pid})),
    freeStorage: await getStorageStats(),
  }, null, 2))
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
