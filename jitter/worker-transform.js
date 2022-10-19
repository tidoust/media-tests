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
    const mode = e.data.mode || 'identity';

    let counter = 0;
    const generateOutOfOrderFrames = new TransformStream({
      transform(frame, controller) {
        counter++;
        const delay = (counter % 50 === 0) ? 200 : 0;
        if (delay) {
          console.log('delay frame', counter);
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
        inputStream
          .pipeThrough(generateOutOfOrderFrames)
          .pipeTo(outputStream);
        break;
    }
  }
  else if (e.data.type === 'stop') {
  }
});