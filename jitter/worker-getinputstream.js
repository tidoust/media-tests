'use strict';

function rgbToBytes(rgb) {
  return [
    parseInt(rgb.slice(1,3), 16),
    parseInt(rgb.slice(3,5), 16),
    parseInt(rgb.slice(5,7), 16),
    255
  ];
}

function pad(n, width) {
  return n.length >= width ? n : '0' + pad(n, width-1);
}

let writer;
let intervalId;
let started = false;

// TEMP: workaround Chrome failure to close VideoFrames in workers
// when they are transferred to the main thread.
// Drop whenever possible!
const framesToClose = {};

self.addEventListener('message', async function (e) {
  if (e.data.type === 'start') {
    if (started) return;
    started = true;

    const config = e.data.config;
    const colors = config.colors;
    const colorBytes = colors.map(rgbToBytes);
    const width = config.width;
    const height = config.height;
    const frameRate = config.frameRate || 25;
    const frameDuration = Math.round(1000 / frameRate);
    const writableStream = e.data.stream;
    writer = writableStream.getWriter();

    // Create the canvas that will help generate an input stream of frames
    // that encode a frame index
    const inputCanvas = new OffscreenCanvas(width, height);
    const inputCtx = inputCanvas.getContext('2d', { alpha: false });

    function timestampToColors(idx) {
      const str = pad(Number(idx).toString(colors.length), 4);
      const digits = Array.from(str).map(char => parseInt(char, colors.length));
      return digits.map(d => colors[d]);
    }

    function timestampToVideoFrame(timestamp) {
      const colors = timestampToColors(timestamp);
      inputCtx.fillStyle = `${colors[0]}`;
      inputCtx.fillRect(0, 0, width / 2, height / 2);
      inputCtx.fillStyle = `${colors[1]}`;
      inputCtx.fillRect(width / 2, 0, width, height / 2);
      inputCtx.fillStyle = `${colors[2]}`;
      inputCtx.fillRect(0, height / 2, width / 2, height);
      inputCtx.fillStyle = `${colors[3]}`;
      inputCtx.fillRect(width / 2, height / 2, width, height);
      return new VideoFrame(inputCanvas, {
        timestamp: timestamp * 1000,
        alpha: 'discard'
      });
    }

    // Produce VideoFrames roughly every frameDuration milliseconds, taking
    // backpressure into account.
    let startTimestamp = performance.now();
    let previousTimestamp = 0;

    async function writeVideoFrame() {
      if (!started) return;
      const writeStart = performance.now();

      // Cater for backpressure
      await writer.ready;
      if (!started) return;

      // Create and write next VideoFrame
      // (unless function was called within 0ms of the previous call)
      const timestamp = Math.round(performance.now() - startTimestamp);
      if (timestamp > previousTimestamp) {
        const frame = timestampToVideoFrame(timestamp);
        // TEMP: workaround Chrome failure to close VideoFrames in workers
        // when they are transferred to the main thread.
        // Drop whenever possible!
        if (config.closeHack) {
          framesToClose[frame.timestamp] = frame;
        }
        await writer.write(frame);
      }

      // Next VideoFrame is due in xx ms
      let sleep = frameDuration - Math.round(performance.now() - writeStart);

      // ... but if previous generation took a bit longer, let's compensate
      // (not taking skipped frames into account)
      if ((timestamp - previousTimestamp) > frameDuration) {
        sleep -= (timestamp - previousTimestamp) % frameDuration;
      }

      // Back to the future is only for Doc'
      if (sleep < 0) {
        sleep = 0;
      }

      // Schedule next VideoFrame generation
      setTimeout(writeVideoFrame, sleep);
      previousTimestamp = timestamp;
    }

    writeVideoFrame();
  }
  else if (e.data.type === 'stop') {
    if (!started) return;
    started = false;
    if (writer) {
      writer.abort();
      writer = null;
    }
  }
  // TEMP: workaround Chrome failure to close VideoFrames in workers
  // when they are transferred to the main thread.
  // Drop whenever possible!
  else if (e.data.type === 'closeframe') {
    const frame = framesToClose[e.data.timestamp];
    if (frame) {
      frame.close();
      delete framesToClose[e.data.timestamp];
    }
  }
});