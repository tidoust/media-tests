'use strict';

importScripts('VideoFrameTimestampDecorator.js');

// TEMP: workaround Chrome failure to close VideoFrames in workers
// when they are transferred to the main thread.
// Drop whenever possible!
const framesToClose = {};


self.addEventListener('message', async function(e) {
  if (e.data.type === 'start') {
    VideoFrameTimestampDecorator.resetStats();
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;
    const config = e.data.config;

    const addTimestampToFrame = new VideoFrameTimestampDecorator(config);

    inputStream
      .pipeThrough(addTimestampToFrame)
      // TEMP: workaround Chrome failure to close VideoFrames in workers
      // when they are transferred to the main thread.
      // Drop whenever possible!
      .pipeThrough(new TransformStream({
        transform(frame, controller) {
          if (config.closeHack) {
            framesToClose[frame.timestamp] = frame;
          }
          controller.enqueue(frame);
        }
      }))
      .pipeTo(outputStream);
  }
  else if (e.data.type === 'stop') {
    const stats = VideoFrameTimestampDecorator.collectStats();
    VideoFrameTimestampDecorator.resetStats();
    self.postMessage({ type: 'stats', stats });
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