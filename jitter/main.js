'use strict';

let inputWorker;
let transformWorker;
let outputFramesToTrack;
let stopped = false;
let frameTimes = [];

const width = 1920;
const height = 1080;

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
  inputWorker.postMessage({ type: 'stop' });
  transformWorker.postMessage({ type: 'stop' });
  if (outputFramesToTrack) {
    outputFramesToTrack.stop();
  }
  const stats = framestats_report();
  console.log(stats);
}

function framestats_report() {
  function array_report(durations) {
    const all = durations.slice().map(dur => Math.round(dur));
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
      median,
      all
    };
  }

  const diff = frameTimes.slice(0, -1)
    .map((f, idx) => frameTimes[idx + 1].end - f.end);

  const maxTimestamp = Math.max(...frameTimes.map(f => f.timestamp));
  const missed = [];
  for (let i = 1; i <= maxTimestamp; i++) {
    if (!frameTimes.find(f => f.timestamp === i)) {
      missed.push(i);
    }
  }

  const res = {
    diff: array_report(diff),
    missed
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

    // Generate a stream of VideoFrames in a dedicated worker
    // and pass the result as input of the transform worker
    const inputTransform = new TransformStream();
    inputWorker.postMessage({
      type: 'start',
      stream: inputTransform.writable,
      colors, width, height,
      frameDuration: 40
    }, [inputTransform.writable]);

    // The transform worker will create another stream of VideoFrames,
    // which we'll convert to a MediaStreamTrack for rendering onto the
    // video element.
    outputFramesToTrack = new MediaStreamTrackGenerator({ kind: 'video' });

    transformWorker.postMessage({
      type: 'start',
      streams: {
        input: inputTransform.readable,
        output: outputFramesToTrack.writable
      }
    }, [inputTransform.readable, outputFramesToTrack.writable]);

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
      if (video.currentTime > 0) {
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