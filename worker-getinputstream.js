'use strict';

/**
 * Worker that produces a stream of VideoFrame.
 * 
 * Produced stream represents a Nyan-Cat-like animation featuring the W3C logo.
 * This is done by preparing individual frames in a canvas and by creating a
 * VideoFrame object out of it.
 * 
 * Frames are produced at the requested frame rate if possible. Backpressure
 * signals received from downstream will slow generation and may mean that some
 * frames cannot be generated in time or at all.
 */

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

    // Create the canvas onto which we'll generate our frame drawing
    const inputCanvas = new OffscreenCanvas(width, height);
    const inputCtx = inputCanvas.getContext('2d', { alpha: false });

    // Rough animation speed control
    // TODO: make animation independent of frame rate
    const nbFramesBeforeNextMove = 2;

    // Stars
    const starRectWidth = 10;
    const starRectHeight = 10;
    const starPhases = [
      {
        rectangles: [
          { x: 0, y: 0 }
        ]
      },
      {
        rectangles: [
          { x: 0 - starRectWidth, y: 0 },
          { x: starRectWidth, y: 0 },
          { x: 0, y: 0 - starRectHeight },
          { x: 0, y: starRectHeight }
        ]
      },
      {
        rectangles: [
          { x: 0 - starRectWidth, y: 0 },
          { x: starRectWidth, y: 0 },
          { x: 0, y: 0 - starRectHeight },
          { x: 0, y: starRectHeight },
          { x: 0 - 2 * starRectWidth, y: 0 },
          { x: 2 * starRectWidth, y: 0 },
          { x: 0, y: 0 - 2 * starRectHeight },
          { x: 0, y: 2 * starRectHeight }
        ]
      },
      {
        rectangles: [
          { x: 0, y: 0 },
          { x: -2 * starRectWidth, y: 0 },
          { x: 2 * starRectWidth, y: 0 },
          { x: 0, y: -2 * starRectHeight },
          { x: 0, y: 2 * starRectHeight },
          { x: -3 * starRectWidth, y: 0 },
          { x: 3 * starRectWidth, y: 0 },
          { x: 0, y: -3 * starRectHeight },
          { x: 0, y: 3 * starRectHeight }
        ]
      },
      {
        rectangles: [
          { x: 0, y: 0 },
          { x: -3 * starRectWidth, y: 0 },
          { x: 3 * starRectWidth, y: 0 },
          { x: 0, y: -3 * starRectHeight },
          { x: 0, y: 3 * starRectHeight }
        ]
      },
      {
        rectangles: [
          { x: -3 * starRectWidth, y: 0 },
          { x: 3 * starRectWidth, y: 0 },
          { x: 0, y: -3 * starRectHeight },
          { x: 0, y: 3 * starRectHeight },
          { x: -2.5 * starRectWidth, y: starRectHeight },
          { x: 2.5 * starRectWidth, y: starRectHeight },
          { x: -2.5 * starRectWidth, y: 0 - starRectHeight },
          { x: 2.5 * starRectWidth, y: 0 - starRectHeight },
          { x: starRectWidth, y: -2.5 * starRectHeight },
          { x: starRectWidth, y: 2.5 * starRectHeight },
          { x: 0 - starRectWidth, y: -2.5 * starRectHeight },
          { x: 0 - starRectWidth, y: 2.5 * starRectHeight }
        ]
      },
      {
        rectangles: [
          { x: -3 * starRectWidth, y: 0 },
          { x: 3 * starRectWidth, y: 0 },
          { x: 0, y: -3 * starRectHeight },
          { x: 0, y: 3 * starRectHeight },
          { x: -2.5 * starRectWidth, y: starRectHeight },
          { x: 2.5 * starRectWidth, y: starRectHeight },
          { x: -2.5 * starRectWidth, y: 0 - starRectHeight },
          { x: 2.5 * starRectWidth, y: 0 - starRectHeight },
          { x: starRectWidth, y: -2.5 * starRectHeight },
          { x: starRectWidth, y: 2.5 * starRectHeight },
          { x: 0 - starRectWidth, y: -2.5 * starRectHeight },
          { x: 0 - starRectWidth, y: 2.5 * starRectHeight },
          { x: -2 * starRectWidth, y: -2 * starRectHeight },
          { x: -2 * starRectWidth, y: 2 * starRectHeight },
          { x: 2 * starRectWidth, y: -2 * starRectHeight },
          { x: 2 * starRectWidth, y: 2 * starRectHeight }
        ]
      }
    ];

    const nbStars = 20;
    const nbStarRows = 4;
    const nbStarsPerRow = nbStars / nbStarRows;

    const stars = [];
    for (let i = 0; i < nbStars; i++) {
      const col = i % nbStarsPerRow;
      let row = Math.floor(i / nbStarsPerRow);
      const colWidth = width / nbStarsPerRow;
      const rowHeight = height / nbStarRows;
      stars[i] = {
        x: col * (width + 3 * starRectWidth) / nbStarsPerRow +
          colWidth / 2 + getRandomInt(-colWidth / 4, colWidth / 4),
        y: row * height / nbStarRows +
          rowHeight / 2 + getRandomInt(-rowHeight / 8, rowHeight / 8),
        phase: getRandomInt(0, starPhases.length),
        pause: 0
      }
    }
    const starVelocity = -20;

    // Rainbow
    const rainbow = {
      x: width / 3,
      y: height / 2,
      phase: 0,
      pause: 0
    };
    const rainbowStripeWidth = 80;
    const rainbowStripeHeight = 20;
    const rainbowColors = [
      '#f00',
      '#f90',
      '#ff0',
      '#8fb',
      '#09f',
      '#63f'
    ];

    function timestampToVideoFrame(timestamp) {
      // W3C blue! No, green FTW!
      //inputCtx.fillStyle = '#005a9c';
      inputCtx.fillStyle = '#009c02';
      inputCtx.fillRect(0, 0, width, height);

      // Render timestamp
      inputCtx.fillStyle = 'white';
      inputCtx.font = '32px Arial';
      inputCtx.fillText(`Timestamp: ${timestamp}`, 10, 42);

      // Render the stars
      stars.forEach(star => {
        inputCtx.fillStyle = 'white';
        starPhases[star.phase].rectangles.forEach(rect => {
          inputCtx.fillRect(
            star.x + rect.x,
            star.y + rect.y,
            starRectWidth,
            starRectHeight
          );
        });
        if (star.pause < nbFramesBeforeNextMove) {
          star.pause += 1;
        }
        else {
          star.phase = (star.phase + 1) % starPhases.length;
          star.pause = 0;
        }
        star.x += starVelocity;
        if (star.x < -3 * starRectWidth) {
          star.x = width + 3 * starRectWidth;
        }
      });

      // Render the rainbow
      const stripe = {
        x: rainbow.x - rainbowStripeWidth,
        y: rainbow.y - 3 * rainbowStripeHeight,
        phase: rainbow.phase
      };
      while (stripe.x > 0 - rainbowStripeWidth) {
        rainbowColors.forEach(color => {
          inputCtx.fillStyle = color;
          inputCtx.fillRect(
            stripe.x,
            stripe.y + ((stripe.phase === 1) ? rainbowStripeHeight / 4 : 0),
            rainbowStripeWidth,
            rainbowStripeHeight
          );
          stripe.y += rainbowStripeHeight;
        });
        stripe.x -= rainbowStripeWidth;
        stripe.y = rainbow.y - 3 * rainbowStripeHeight;
        stripe.phase = (stripe.phase + 1) % 2;
      }
      if (rainbow.pause < 2 * nbFramesBeforeNextMove) {
        rainbow.pause += 1;
      }
      else {
        rainbow.phase = (rainbow.phase + 1) % 2;
        rainbow.pause = 0;
      }

      // Render W3C icon next to rainbow
      inputCtx.drawImage(config.icon, rainbow.x, rainbow.y - 192/2 + ((rainbow.phase === 1) ? rainbowStripeHeight / 4 : 0));

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
      writer.close();
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