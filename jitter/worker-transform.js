'use strict';

let started = false;

self.addEventListener('message', async function(e) {
  if (e.data.type === 'start') {
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;
    inputStream.pipeTo(outputStream);
  }
  else if (e.data.type === 'stop') {
  }
});