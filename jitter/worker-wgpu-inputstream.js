'use strict';

let started = false;

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

const frames = {};

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
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;

    // Create the canvas that will help generate an input stream of frames
    // that encode a frame index
    /*const inputCanvas = new OffscreenCanvas(width, height);
    const inputCtx = inputCanvas.getContext('2d', { alpha: false });*/

    const writeTimestamp = new TransformStream({
      transform(frame, controller) {
        console.log('enqueued', frame.timestamp);
        frames[frame.timestamp] = frame;
        controller.enqueue(frame);
      }
    });

    inputStream
      .pipeThrough(writeTimestamp)
      .pipeTo(outputStream);
  }
  else if (e.data.type === 'stop') {
    if (!started) return;
    started = false;
  }
  else if (e.data.type === 'closeframe') {
    frames[e.data.timestamp].close();
    frames[e.data.timestamp] = null;
  }
});
