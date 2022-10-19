'use strict';

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
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
  '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000',
  '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080',
  '#ffffff', '#000000'];
const colorBytes = colors.map(rgbToBytes);

function colorsToTimestamp(pixels) {
  const digits = pixels.map(pixel =>
    colorBytes.findIndex(c => c.every((t, i) => t === pixel[i])));
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
  if (frameTimes.length > 0) {
    const stats = framestats_report();
    console.log(stats);
  }
}

function framestats_report() {
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

  frameTimes.slice(0, -1)
    .forEach((f, idx) => f.duration = frameTimes[idx + 1].end - f.end);
  const diff = frameTimes.slice(0, -1).map(f => f.duration);

  const maxTimestamp = Math.max(...frameTimes.map(f => f.timestamp));
  const missed = [];
  for (let i = 1; i <= maxTimestamp; i++) {
    if (!frameTimes.find(f => f.timestamp === i)) {
      missed.push(i);
    }
  }

  const outoforder = frameTimes
    .filter((f, idx) => idx > 0 && frameTimes[idx - 1].timestamp > f.timestamp);

  const res = {
    all: frameTimes.map(f => {
      return { ts: f.timestamp, dur: Math.round(f.duration) };
    }),
    diff: array_report(diff),
    missed,
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

  async function startMedia() {
    frameTimes = [];

    // What input stream should we use as input?
    const streamMode = document.querySelector('input[name="streammode"]:checked')?.value ||
      'generated';

    // Get the requested transformation mode
    const transformMode = document.querySelector('input[name="mode"]:checked')?.value;

    // Get the requested frame rate
    const frameRate = parseInt(document.getElementById('framerate').value, 10);

    const config = {
      streamMode,
      transformMode,
      colors,
      width,
      height,
      frameRate
    };

    if (streamMode === 'generated') {
      // Generate a stream of VideoFrames in a dedicated worker
      // and pass the result as input of the transform worker
      const inputTransform = new TransformStream();
      inputWorker.postMessage({
        type: 'start',
        config,
        stream: inputTransform.writable
      }, [inputTransform.writable]);
      inputStream = inputTransform.readable;
    }
    else {
      const constraints = JSON.parse(JSON.stringify(hdConstraints));
      constraints.video.frameRate = frameRate;
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      inputTrack = mediaStream.getVideoTracks()[0];
      console.log(inputTrack.getSettings());
      const processor = new MediaStreamTrackProcessor({ track: inputTrack });
      inputStream = processor.readable;
    }

    // The transform worker will create another stream of VideoFrames,
    // which we'll convert to a MediaStreamTrack for rendering onto the
    // video element.
    outputFramesToTrack = new MediaStreamTrackGenerator({ kind: 'video' });

    transformWorker.postMessage({
      type: 'start',
      config,
      streams: {
        input: inputStream,
        output: outputFramesToTrack.writable
      }
    }, [inputStream, outputFramesToTrack.writable]);

    const video = document.getElementById('outputVideo');
    video.srcObject = new MediaStream([outputFramesToTrack]);

    // Read back the contents of the video element onto a canvas
    const outputCanvas = new OffscreenCanvas(width, height);
    const outputCtx = outputCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

    let prevPresentedFrames = 0;
    function processFrame(ts, { presentedFrames }) {
      if (stopped) return;
      if (presentedFrames && presentedFrames > prevPresentedFrames + 1) {
        console.log('requestVideoFrameCallback', 'missed frame: ',
          presentedFrames, 'nb missed: ', presentedFrames - prevPresentedFrames - 1);
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
        if (!frameTimes.find(f => f.timestamp === frameIndex)) {
          frameTimes.push({
            timestamp: frameIndex,
            end: ts
          });
        }
      }

      video.requestVideoFrameCallback(processFrame);
    }
    video.requestVideoFrameCallback(processFrame);
  }
}, false);