'use strict';

let started = false;

function rnd(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min);
}

self.addEventListener('message', async function(e) {
  if (e.data.type === 'start') {
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;
    const config = e.data.config;
    const mode = config.transformMode || 'identity';
    const frameRate = config.frameRate || 25;
    const frameDuration = Math.round(1000 / frameRate);

    let counter = 0;
    const generateOutOfOrderFrames = new TransformStream({
      transform(frame, controller) {
        counter++;
        const frameId = config.streamMode === 'generated' ? frame.timestamp : counter;
        let delay = 0;
        switch (mode) {
          case 'outoforder':
            delay = (frameId && frameId % (5 * frameRate) === 0) ?
              4 * frameDuration :
              0;
            break;
          case 'longer':
            delay = (frameId && frameId % (2 * frameRate) === 0) ?
              Math.round(frameDuration / 3) :
              0;
            break;
        }
        if (delay) {
          console.log('delay frame', frameId);
        }
        setTimeout(function () {
          controller.enqueue(frame);
        }, delay);
      }
    });

    switch (mode) {
      case 'identity':
        inputStream
          .pipeTo(outputStream);
        break;
      case 'outoforder':
      case 'longer':
        inputStream
          .pipeThrough(generateOutOfOrderFrames)
          .pipeTo(outputStream);
        break;
    }
  }
  else if (e.data.type === 'stop') {
  }
});