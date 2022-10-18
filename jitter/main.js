'use strict';

let inputWriter;
let generator;
let intervalId;
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

function pad(n, width) {
  return n.length >= width ? n : '0' + pad(n, width-1);
}

function timestampToColors(idx) {
  const str = pad(Number(idx).toString(colors.length), 4);
  const digits = Array.from(str).map(char => parseInt(char, colors.length));
  return digits.map(d => colors[d]);
}

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
  if (intervalId) {
    clearInterval(intervalId);
  }
  inputWriter.abort();
  generator.stop();
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

  let times = frameTimes;
  if (!frameTimes[0].end) {
    times = frameTimes.slice(1);
  }
  const missed = times.filter(f => !f.end);
  times = times.filter(f => !!f.end);
  const durations = times.map(f => f.end - f.start);
  const diff = times.slice(0, -1)
    .map((f, idx) => times[idx + 1].end - f.end);

  const res = {
    glass2glass: array_report(durations),
    diff: array_report(diff),
    missed
  };

  return res;
}

document.addEventListener('DOMContentLoaded', async function(event) {
  if (stopped) return;
  stopButton.onclick = stop;

  startButton.onclick = () => {
    stopped = false;
    startButton.disabled = true;
    stopButton.disabled = false;
    startMedia();
  }

  async function startMedia() {
    frameTimes = [];

    // Create canvas
    const inputCanvas = new OffscreenCanvas(width, height);
    const inputCtx = inputCanvas.getContext('2d', { alpha: false });

    function makeUniformVideoFrame(timestamp) {
      const colors = timestampToColors(timestamp);
      inputCtx.fillStyle = `${colors[0]}`;
      inputCtx.fillRect(0, 0, width / 2, height / 2);
      inputCtx.fillStyle = `${colors[1]}`;
      inputCtx.fillRect(width / 2, 0, width, height / 2);
      inputCtx.fillStyle = `${colors[2]}`;
      inputCtx.fillRect(0, height / 2, width / 2, height);
      inputCtx.fillStyle = `${colors[3]}`;
      inputCtx.fillRect(width / 2, height / 2, width, height);
      return new VideoFrame(inputCanvas, { timestamp, alpha: 'discard' });
    }

    // Write 25 frames per second into the canvas
    // and generate an input MediaStreamTrack from it.
    const inputGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
    inputWriter = inputGenerator.writable.getWriter();
    let timestamp = 0;
    intervalId = setInterval(async () => {
      if (inputGenerator.readyState === 'live') {
        frameTimes.push({ timestamp, start: performance.now() });
        await inputWriter.write(makeUniformVideoFrame(timestamp));
        timestamp++;
      }
    }, 40);

    // Convert the MediaStreamTrack to VideoFrame objects
    const processor = new MediaStreamTrackProcessor({track: inputGenerator});
    
    // Convert VideoFrame objects to a MediaStreamTrack
    generator = new MediaStreamTrackGenerator({kind: 'video'});
    processor.readable.pipeTo(generator.writable);

    // Output the MediaStreamTrack to a video element
    const video = document.getElementById('outputVideo');
    video.srcObject = new MediaStream([generator]);

    // Read back the contents of the video element onto a canvas
    const outputCanvas = new OffscreenCanvas(width, height);
    const outputCtx = outputCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

    let prevPresentedFrames = 0;
    function processFrame(ts, { presentedFrames }) {
      if (stopped) return;
      if (presentedFrames && presentedFrames > prevPresentedFrames + 1) {
        console.log('missed frames', presentedFrames, presentedFrames - prevPresentedFrames - 1);
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
        const ftimes = frameTimes.find(f => f.timestamp === frameIndex);
        if (!ftimes.end) {
          ftimes.end = performance.now();
        }
      }

      video.requestVideoFrameCallback(processFrame);
    }
    video.requestVideoFrameCallback(processFrame);
  }
}, false);