'use strict';

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min);
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

    // Configuration
    const config = e.data.config;
    const width = config.width;
    const height = config.height;
    const frameRate = config.frameRate || 25;
    const frameDuration = Math.round(1000 / frameRate);
    const writableStream = e.data.stream;
    writer = writableStream.getWriter();

    // Create the canvas that will help generate an input stream of frames
    const inputCanvas = new OffscreenCanvas(width, height);
    const inputCtx = inputCanvas.getContext('2d', { alpha: false });

    // Current position and velocity of the logo
    const position = {
      x: getRandomInt(0, width / 4),
      y: getRandomInt(0, height / 4)
    };
    const velocity = {
      x: getRandomInt(5, 30),
      y: getRandomInt(5, 30)
    };

    function timestampToVideoFrame(timestamp) {
      inputCtx.fillStyle = '#005a9c';
      inputCtx.fillRect(0, 0, width, height);

      // Render timestamp
      inputCtx.fillStyle = "white";
      inputCtx.font = "32px Arial";
      inputCtx.fillText(`Timestamp: ${timestamp}`, 10, 42);

      inputCtx.drawImage(config.icon, position.x, position.y);

      // Bump on frame borders
      position.x += velocity.x;
      position.y += velocity.y;
      if (position.x < 0) {
        position.x = 0 - position.x;
        velocity.x = 0 - velocity.x;
      }
      if (position.y < 0) {
        position.y = 0 - position.y;
        velocity.y = 0 - velocity.y;
      }
      if (position.x > width - config.icon.width) {
        position.x = 2 * (width - config.icon.width) - position.x;
        velocity.x = 0 - velocity.x;
      }
      if (position.y > height - config.icon.height) {
        position.y = 2 * (height - config.icon.height) - position.y;
        velocity.y = 0 - velocity.y;
      }

      // Bump on timestamp overlay
      if (config.overlayMode === 'timestamp') {
        if ((position.x > width / 2 - config.icon.width) &&
            (position.y > height / 2 - config.icon.height)) {
          if (position.x - (width / 2 - config.icon.width) <
              position.y - (height / 2 - config.icon.height)) {
            position.x = 2 * (width / 2 - config.icon.width) - position.x;
            velocity.x = 0 - velocity.x;
          }
          else {
            position.y = 2 * (height / 2 - config.icon.height) - position.y;
            velocity.y = 0 - velocity.y;
          }
        }
      }

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
        writer.write(frame);
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