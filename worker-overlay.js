'use strict';

/**
 * Worker that takes a stream of VideoFrame as input and adds an overlay in
 * the bottom right corner that encodes the timestamp of each VideoFrame.
 * 
 * The worker uses VideoFrameTimestampDecorator under the hoods.
 */


importScripts('InstrumentedTransformStream.js');
importScripts('VideoFrameTimestampDecorator.js');

// TEMP: VideoFrames sent through a TransformStream are serialized (and thus
// cloned) and not transferred for now. This means that they need to be closed
// on both ends, in particular when TransformStream sits across workers.
// Unfortunately, they cannot be closed right away on the sender's end because
// the receiver may not yet have received them. Workaround is to close them at
// the end of the processing.
// For additional context, see https://github.com/whatwg/streams/issues/1187
const framesToClose = {};


self.addEventListener('message', async function(e) {
  if (e.data.type === 'start') {
    InstrumentedTransformStream.resetStats();
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;
    const config = e.data.config;

    const addOverlayTransformer = new VideoFrameTimestampDecorator(config);
    const addTimestampToFrame = new InstrumentedTransformStream(
      Object.assign({ name: 'overlay' }, addOverlayTransformer));

    inputStream
      .pipeThrough(addTimestampToFrame)
      // TEMP: VideoFrame close hack
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
    const stats = InstrumentedTransformStream.collectStats();
    InstrumentedTransformStream.resetStats();
    self.postMessage({ type: 'stats', stats });
  }
  // TEMP: VideoFrame close hack
  else if (e.data.type === 'closeframe') {
    const frame = framesToClose[e.data.timestamp];
    if (frame) {
      frame.close();
      delete framesToClose[e.data.timestamp];
    }
  }
});