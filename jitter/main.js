'use strict';

// TEMP: workaround Chrome failure to close VideoFrames in workers
// when they are transferred to the main thread.
// Drop whenever possible!
const closeHack = true;
const framesToClose = {};

let inputWorker;
let transformWorker;
let inputStream;
let inputTrack;
let outputFramesToTrack;
let stopped = false;
let frameTimes = [];

const width = 1920;
const height = 1080;

const hdConstraints = {
  video: { width: 1280, height: 720 }
};

const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');

startButton.disabled = false;
stopButton.disabled = true;

function rgbToBytes(rgb) {
  return [
    parseInt(rgb.slice(1,3), 16),
    parseInt(rgb.slice(3,5), 16),
    parseInt(rgb.slice(5,7), 16),
    255
  ];
}

const colors = [
  '#000000',
  '#500000', '#A00000', '#F00000',
  '#005000', '#00A000', '#00F000',
  '#000050', '#0000A0', '#0000F0',
  '#505000', '#50A000', '#50F000',
  '#500050', '#5000A0', '#5000F0',
  '#A05000', '#A0A000', '#A0F000',
  '#A00050', '#A000A0', '#A000F0',
  '#F05000', '#F0A000', '#F0F000',
  '#F00050', '#F000A0', '#F000F0',
  '#505050', '#5050A0', '#5050F0',
  '#A05050', '#A050A0', '#A050F0'
];
const colorBytes = colors.map(rgbToBytes);

function colorsToTimestamp(pixels) {
  const digits = pixels.map(pixel =>
    colorBytes.findIndex(c => c.every((t, i) => Math.abs(t - pixel[i]) < 32)));
  const str = digits.map(d => d.toString(colors.length)).join('');
  const frameIndex = parseInt(str, colors.length);
  return frameIndex;
}

function stop() {
  stopped = true;
  stopButton.disabled = true;
  startButton.disabled = false;
  if (inputTrack) {
    inputTrack.stop();
    inputTrack = null;
  }
  inputWorker.postMessage({ type: 'stop' });
  transformWorker.postMessage({ type: 'stop' });
}

function framestats_report(workerTimes) {
  function array_report(durations) {
    durations = durations.slice().sort();
    const count = durations.length;
    const sum = durations.reduce((sum, duration) => sum + duration, 0);
    const half = count >> 1;
    const median = Math.round(count % 2 === 1 ? durations[half] : (durations[half - 1] + durations[half]) / 2);
    return {
      count,
      min: Math.round(Math.min(...durations)),
      max: Math.round(Math.max(...durations)),
      avg: Math.round(sum / count),
      median
    };
  }

  function getDurations(stats, finalStep, startingStep) {
    startingStep = startingStep ?? finalStep;
    return stats
      .filter(s => s[finalStep]?.end && s[startingStep]?.start)
      .map(s => s[finalStep].end - s[startingStep].start);
  }

  function getQueuedDuration(stats) {
    const times = Object.values(stats)
      .filter(v => v?.start)
      .sort((times1, times2) => times1.start - times2.start);
    return times.slice(0, -1)
      .map((s, idx) => times[idx + 1].start - s.end)
      .reduce((curr, total) => total += curr, 0);
  }

  // Compute approximative time during which all frame was displayed
  frameTimes.slice(0, -1).forEach((f, idx) => {
    f.displayDuration = frameTimes[idx + 1].expectedDisplayTime - f.expectedDisplayTime;
  });

  // Collect stats from main thread
  const all = InstrumentedTransformStream.collectStats();
  InstrumentedTransformStream.resetStats();

  // Complete stats with worker stats and display stats
  all.forEach(s => {
    const wTimes = workerTimes.find(w => w.ts === s.ts);
    if (wTimes) {
      Object.assign(s, wTimes);
    }

    const fTimes = frameTimes.find(f => f.ts === s.ts);
    if (fTimes) {
      s.expectedDisplayTime = fTimes.expectedDisplayTime;
      s.displayDuration = fTimes.displayDuration;
    }
  });

  const displayDiff = frameTimes.slice(0, -1)
    .map(f => f.displayDuration)
    .filter(dur => dur > 0);

  const outoforder = frameTimes
    .filter((f, idx) => idx > 0 && frameTimes[idx - 1].ts > f.ts);

  const res = {
    all,
    durations: all.map(s => {
      return {
        ts: s.ts,
        end2end: Math.round(s.final?.end - s.input?.start),
        encoding: s.encode ? Math.round(s.encode.end - s.encode.start) : 0,
        decoding: s.decode ? Math.round(s.decode.end - s.decode.start) : 0,
        outoforder: s.outoforder ? Math.round(s.outoforder.end - s.outoforder.start) : 0,
        longer: s.longer ? Math.round(s.longer.end - s.longer.start) : 0,
        display: Math.round(s.displayDuration),
        queued: getQueuedDuration(s)
      };
    }),
    stats: {
      end2end: array_report(getDurations(all, 'final', 'input')),
      encoding: array_report(getDurations(all, 'encode')),
      decoding: array_report(getDurations(all, 'decode')),
      outoforder: array_report(getDurations(all, 'outoforder')),
      longer: array_report(getDurations(all, 'longer')),
      display: array_report(displayDiff),
      queued: array_report(all.map(getQueuedDuration))
    },
    outoforder
  };

  return res;
}

document.addEventListener('DOMContentLoaded', async function (event) {
  if (stopped) return;
  stopButton.onclick = stop;

  startButton.onclick = () => {
    stopped = false;
    startButton.disabled = true;
    stopButton.disabled = false;
    startMedia();
  }

  inputWorker = new Worker('worker-getinputstream.js');
  transformWorker = new Worker('worker-transform.js');
  transformWorker.addEventListener('message', e => {
    if (e.data.type === 'stats') {
      if (frameTimes.length > 0) {
        const stats = framestats_report(e.data.stats);
        console.log(stats);
      }
    }
  });

  async function startMedia() {
    // Reset stats
    InstrumentedTransformStream.resetStats();
    frameTimes = [];

    // Get the requested frame rate
    const frameRate = parseInt(document.getElementById('framerate').value, 10);

    // What input stream should we use as input?
    const streamMode = document.querySelector('input[name="streammode"]:checked')?.value ||
      'generated';

    // Encoding/Decoding mode
    const encodeMode = document.querySelector('input[name="encodemode"]:checked')?.value ||
      'none';

    let encodeConfig;
    switch (encodeMode) {
      case 'none':
      case 'H264':
        encodeConfig = {
          alpha: 'discard',
          latencyMode: 'realtime',
          bitrateMode: 'variable',
          codec: 'H264',
          width,
          height,
          bitrate: 1000000, 
          framerate: frameRate,
          keyInterval: 300,
          codec: 'avc1.42002A',
          avc: { format: 'annexb' },
          pt: 1
        };
    }

    // Get the requested transformation mode
    const transformMode = document.querySelector('input[name="mode"]:checked')?.value;


    const config = {
      streamMode,
      encodeMode,
      transformMode,
      colors,
      width,
      height,
      frameRate,
      encodeConfig,
      closeHack
    };

    const inputTransform = new InstrumentedTransformStream({
      name: 'input',
      transform(frame, controller) {
        if (closeHack) {
          framesToClose[frame.timestamp] = frame;
        }
        // Compute end time before calling enqueue as next TransformStream
        // starts right when enqueue is called
        this.setEndTime(frame.timestamp);
        controller.enqueue(frame);
      }
    });
    if (streamMode === 'generated') {
      // Generate a stream of VideoFrames in a dedicated worker
      // and pass the result as input of the transform worker
      inputWorker.postMessage({
        type: 'start',
        config,
        stream: inputTransform.writable
      }, [inputTransform.writable]);
    }
    else {
      // Generate a MediaStreamTrack from the camera and pass the result in a
      // MediaStreamTrackProcess to generate a stream of VideoFrames that can
      // be fed as in put of the transform worker
      const constraints = JSON.parse(JSON.stringify(hdConstraints));
      constraints.video.frameRate = frameRate;
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      inputTrack = mediaStream.getVideoTracks()[0];
      console.log(inputTrack.getSettings());
      const processor = new MediaStreamTrackProcessor({ track: inputTrack });
      processor.readable.pipeThrough(inputTransform);
    }
    inputStream = inputTransform.readable;

    // TEMP: workaround Chrome failure to close VideoFrames in workers
    // when they are transferred to the main thread.
    // Drop whenever possible!
    const closeTransform = new InstrumentedTransformStream({
      name: 'final',
      transform(frame, controller) {
        if (closeHack) {
          if (streamMode === 'generated') {
            inputWorker.postMessage({
              type: 'closeframe',
              timestamp: frame.timestamp
            });
          }
          transformWorker.postMessage({
            type: 'closeframe',
            timestamp: frame.timestamp
          });
          const inputFrame = framesToClose[frame.timestamp];
          if (inputFrame) {
            inputFrame.close();
            delete framesToClose[frame.timestamp];
          }
        }
        this.setEndTime(frame.timestamp);
        controller.enqueue(frame);
      }
    });

    transformWorker.postMessage({
      type: 'start',
      config,
      streams: {
        input: inputStream,
        output: closeTransform.writable
      }
    }, [inputStream, closeTransform.writable]);

    // The transform worker will create another stream of VideoFrames,
    // which we'll convert to a MediaStreamTrack for rendering onto the
    // video element.
    outputFramesToTrack = new MediaStreamTrackGenerator({ kind: 'video' });
    closeTransform.readable.pipeTo(outputFramesToTrack.writable);

    const video = document.getElementById('outputVideo');
    video.srcObject = new MediaStream([outputFramesToTrack]);

    // Read back the contents of the video element onto a canvas
    const outputCanvas = new OffscreenCanvas(width, height);
    const outputCtx = outputCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

    let prevPresentedFrames = 0;
    function processFrame(ts, { presentedFrames, expectedDisplayTime }) {
      if (stopped) return;
      if (presentedFrames && presentedFrames > prevPresentedFrames + 1) {
        let missed = presentedFrames - prevPresentedFrames - 1;
        console.log('missed frame sent to compositor',
          '| sent:', presentedFrames,
          '| missed:', missed);
        while (missed) {
          // Record missed frames
          frameTimes.push({
            timestamp: -1,
            expectedDisplayTime
          });
          missed--;
        }
      }
      prevPresentedFrames = presentedFrames;
      if (video.currentTime > 0 && streamMode === 'generated') {
        outputCtx.drawImage(video, 0, 0);

        // Pick pixels at the center of each quadrant of the canvas
        const pixels = [
          outputCtx.getImageData(width / 4, height / 4, 1, 1).data,
          outputCtx.getImageData(3 * width / 4, height / 4, 1, 1).data,
          outputCtx.getImageData(width / 4, 3 * height / 4, 1, 1).data,
          outputCtx.getImageData(3 * width / 4, 3 * height / 4, 1, 1).data
        ];

        const frameIndex = colorsToTimestamp(pixels);
        if (frameTimes.find(f => f.ts === frameIndex * 1000)) {
          console.log('color decoding issue', frameIndex * 1000, pixels);
        }
        frameTimes.push({
          ts: frameIndex * 1000,
          expectedDisplayTime
        });
      }

      video.requestVideoFrameCallback(processFrame);
    }
    video.requestVideoFrameCallback(processFrame);
  }
}, false);